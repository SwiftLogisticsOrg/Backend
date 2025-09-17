require('dotenv').config();
const express = require('express');
const axios = require('axios');

const logger = require('../../shared/logger');
const { asyncHandler, errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');

const app = express();
const PORT = process.env.PORT || 3007;

// ROS API client configuration
const rosClient = axios.create({
  baseURL: process.env.ROS_API_URL,
  timeout: parseInt(process.env.ROS_TIMEOUT) || 45000,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.ROS_API_KEY}`,
    'User-Agent': 'SwiftTrack/1.0'
  }
});

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'ros-adapter',
    externalConnection: process.env.ROS_API_KEY ? 'configured' : 'not-configured'
  });
});

// ROS Adapter Functions
const ROSAdapter = {
  // Transform internal route request to ROS format
  transformRouteRequestToROS(routeRequest) {
    return {
      optimization_profile: routeRequest.profile || 'balanced',
      locations: routeRequest.stops.map(stop => ({
        id: stop.id,
        address: stop.address,
        coordinates: stop.coordinates ? {
          lat: stop.coordinates.latitude,
          lng: stop.coordinates.longitude
        } : null,
        type: stop.type, // 'pickup', 'delivery', 'depot'
        time_windows: stop.timeWindows || [],
        service_time: stop.serviceTime || 300, // 5 minutes default
        priority: stop.priority || 1
      })),
      vehicles: routeRequest.vehicles.map(vehicle => ({
        id: vehicle.id,
        start_location: vehicle.startLocation,
        end_location: vehicle.endLocation || vehicle.startLocation,
        capacity: vehicle.capacity || {},
        max_distance: vehicle.maxDistance,
        max_time: vehicle.maxTime,
        skills: vehicle.skills || []
      })),
      options: {
        traffic: routeRequest.considerTraffic !== false,
        optimize_order: routeRequest.optimizeOrder !== false,
        balance_routes: routeRequest.balanceRoutes || false,
        return_to_depot: routeRequest.returnToDepot || true
      }
    };
  },

  // Transform ROS response to internal format
  transformRouteResponseFromROS(rosResponse) {
    return {
      optimized: true,
      totalDistance: rosResponse.summary.total_distance,
      totalDuration: rosResponse.summary.total_time,
      totalCost: rosResponse.summary.total_cost,
      routes: rosResponse.routes.map(route => ({
        vehicleId: route.vehicle_id,
        distance: route.distance,
        duration: route.duration,
        cost: route.cost,
        steps: route.steps.map(step => ({
          id: step.id,
          type: step.type,
          location: {
            address: step.location.address,
            coordinates: {
              latitude: step.location.coordinates.lat,
              longitude: step.location.coordinates.lng
            }
          },
          arrival: step.arrival,
          departure: step.departure,
          duration: step.duration,
          distance: step.distance,
          description: step.description
        }))
      })),
      unassigned: rosResponse.unassigned || [],
      metadata: {
        optimizationTime: rosResponse.optimization_time,
        provider: 'external-ros',
        timestamp: new Date().toISOString()
      }
    };
  },

  // Optimize route using external ROS
  async optimizeRoute(routeRequest) {
    if (!process.env.ROS_API_KEY) {
      logger.warn('ROS API not configured, using fallback optimization');
      return this.fallbackOptimization(routeRequest);
    }

    try {
      const rosRequest = this.transformRouteRequestToROS(routeRequest);
      
      logger.info('Sending route optimization request to ROS');
      const response = await rosClient.post('/optimize', rosRequest);
      
      if (response.data.status === 'success') {
        return this.transformRouteResponseFromROS(response.data);
      } else {
        throw new Error(`ROS optimization failed: ${response.data.message}`);
      }
    } catch (error) {
      logger.error('ROS optimization error:', error.message);
      
      if (error.response) {
        logger.error('ROS API error response:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      
      // Fallback to simple optimization
      logger.info('Falling back to simple optimization');
      return this.fallbackOptimization(routeRequest);
    }
  },

  // Calculate ETA using external ROS
  async calculateETA(origin, destination, options = {}) {
    if (!process.env.ROS_API_KEY) {
      logger.warn('ROS API not configured, using fallback ETA calculation');
      return this.fallbackETA(origin, destination);
    }

    try {
      const etaRequest = {
        origin: {
          coordinates: {
            lat: origin.latitude,
            lng: origin.longitude
          }
        },
        destination: {
          coordinates: {
            lat: destination.latitude,
            lng: destination.longitude
          }
        },
        options: {
          traffic: options.considerTraffic !== false,
          departure_time: options.departureTime || new Date().toISOString(),
          vehicle_type: options.vehicleType || 'car'
        }
      };

      const response = await rosClient.post('/eta', etaRequest);
      
      if (response.data.status === 'success') {
        return {
          distance: response.data.distance,
          duration: response.data.duration,
          eta: new Date(Date.now() + response.data.duration * 1000),
          route: response.data.route_geometry,
          trafficConsidered: response.data.traffic_considered,
          provider: 'external-ros'
        };
      } else {
        throw new Error(`ROS ETA calculation failed: ${response.data.message}`);
      }
    } catch (error) {
      logger.error('ROS ETA calculation error:', error.message);
      return this.fallbackETA(origin, destination);
    }
  },

  // Fallback optimization when ROS is unavailable
  fallbackOptimization(routeRequest) {
    logger.info('Using fallback route optimization');
    
    // Simple nearest neighbor optimization
    const routes = routeRequest.vehicles.map(vehicle => {
      const availableStops = [...routeRequest.stops];
      const steps = [];
      
      // Start from depot/vehicle location
      let currentLocation = vehicle.startLocation;
      
      while (availableStops.length > 0) {
        // Find nearest stop (simple distance calculation)
        let nearestIndex = 0;
        let minDistance = Infinity;
        
        availableStops.forEach((stop, index) => {
          const distance = this.calculateSimpleDistance(currentLocation, stop.coordinates);
          if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = index;
          }
        });
        
        const nearestStop = availableStops.splice(nearestIndex, 1)[0];
        steps.push({
          id: nearestStop.id,
          type: nearestStop.type,
          location: {
            address: nearestStop.address,
            coordinates: nearestStop.coordinates
          },
          distance: minDistance,
          duration: minDistance * 60, // Rough estimate: 1km = 1 minute
          description: `${nearestStop.type} at ${nearestStop.address}`
        });
        
        currentLocation = nearestStop.coordinates;
      }
      
      const totalDistance = steps.reduce((sum, step) => sum + step.distance, 0);
      const totalDuration = steps.reduce((sum, step) => sum + step.duration, 0);
      
      return {
        vehicleId: vehicle.id,
        distance: totalDistance,
        duration: totalDuration,
        cost: totalDistance * 0.5, // $0.50 per km estimate
        steps
      };
    });
    
    return {
      optimized: false,
      totalDistance: routes.reduce((sum, route) => sum + route.distance, 0),
      totalDuration: routes.reduce((sum, route) => sum + route.duration, 0),
      totalCost: routes.reduce((sum, route) => sum + route.cost, 0),
      routes,
      unassigned: [],
      metadata: {
        provider: 'fallback',
        method: 'nearest-neighbor',
        timestamp: new Date().toISOString()
      }
    };
  },

  // Fallback ETA calculation
  fallbackETA(origin, destination) {
    const distance = this.calculateSimpleDistance(origin, destination);
    const duration = distance * 90; // Assume 40 km/h average speed
    
    return {
      distance,
      duration,
      eta: new Date(Date.now() + duration * 1000),
      route: null,
      trafficConsidered: false,
      provider: 'fallback'
    };
  },

  // Simple distance calculation (Haversine formula)
  calculateSimpleDistance(point1, point2) {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(point2.latitude - point1.latitude);
    const dLon = this.toRad(point2.longitude - point1.longitude);
    const lat1 = this.toRad(point1.latitude);
    const lat2 = this.toRad(point2.latitude);

    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
  },

  toRad(degrees) {
    return degrees * (Math.PI/180);
  }
};

// Routes

/**
 * @swagger
 * /api/ros/optimize:
 *   post:
 *     summary: Optimize route using external ROS
 *     tags: [ROS Adapter]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               stops:
 *                 type: array
 *                 items:
 *                   type: object
 *               vehicles:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Route optimized successfully
 *       500:
 *         description: Optimization failed
 */
app.post('/api/ros/optimize', asyncHandler(async (req, res) => {
  const routeRequest = req.body;
  
  const optimizedRoute = await ROSAdapter.optimizeRoute(routeRequest);
  
  // Publish route optimization event
  await messageBroker.publish(
    messageBroker.exchanges.LOGISTICS,
    'ros.route.optimized',
    {
      requestId: routeRequest.id,
      optimized: optimizedRoute.optimized,
      provider: optimizedRoute.metadata.provider,
      totalDistance: optimizedRoute.totalDistance,
      totalDuration: optimizedRoute.totalDuration,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Route optimization completed:', { 
    provider: optimizedRoute.metadata.provider,
    optimized: optimizedRoute.optimized 
  });

  res.json({
    success: true,
    data: optimizedRoute
  });
}));

/**
 * @swagger
 * /api/ros/eta:
 *   post:
 *     summary: Calculate ETA using external ROS
 *     tags: [ROS Adapter]
 *     security:
 *       - bearerAuth: []
 */
app.post('/api/ros/eta', asyncHandler(async (req, res) => {
  const { origin, destination, options } = req.body;
  
  const eta = await ROSAdapter.calculateETA(origin, destination, options);
  
  // Publish ETA calculation event
  await messageBroker.publish(
    messageBroker.exchanges.LOGISTICS,
    'ros.eta.calculated',
    {
      origin,
      destination,
      distance: eta.distance,
      duration: eta.duration,
      provider: eta.provider,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('ETA calculated:', { 
    distance: eta.distance,
    duration: eta.duration,
    provider: eta.provider 
  });

  res.json({
    success: true,
    data: eta
  });
}));

// Message broker event handlers
async function setupEventHandlers() {
  // Handle order created events for route optimization
  await messageBroker.subscribe(
    messageBroker.queues.ORDER_CREATED,
    async (data) => {
      logger.info('Order created event received, optimizing route:', data);
      
      // Auto-optimize route for new orders
      // This would typically be triggered by logistics service
    }
  );

  // Bind queues to exchanges
  await messageBroker.bindQueue(
    messageBroker.queues.ORDER_CREATED,
    messageBroker.exchanges.ORDERS,
    'order.created'
  );
}

// Error handling
app.use(notFound);
app.use(errorHandler);

// Initialize and start server
async function startServer() {
  try {
    await messageBroker.connect();
    await setupEventHandlers();
    
    app.listen(PORT, () => {
      logger.info(`ROS Adapter running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start ROS Adapter:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await messageBroker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await messageBroker.close();
  process.exit(0);
});

startServer();

module.exports = app;
