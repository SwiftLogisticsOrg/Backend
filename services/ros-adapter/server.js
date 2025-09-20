require('dotenv').config();
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');

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
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));
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
      throw new Error('ROS API not configured');
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
      
      throw error;
    }
  },

  // Calculate ETA using external ROS
  async calculateETA(origin, destination, options = {}) {
    if (!process.env.ROS_API_KEY) {
      throw new Error('ROS API not configured');
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
      throw error;
    }
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
    'order.created.ros',
    async (data) => {
      logger.info('Order created event received, optimizing route:', data);
      
      try {
        // Get nearby drivers who can act as vehicles
        let availableVehicles = [];

        // Configuration constants (defined here instead of using environment variables)
        const LOGISTICS_SERVICE_URL = process.env.LOGISTICS_SERVICE_URL;
        const DRIVER_SEARCH_RADIUS = 50; // km
        const MAX_DRIVERS_PER_ORDER = 5;
        const DEFAULT_VEHICLE_WEIGHT_CAPACITY = 100; // kg
        const DEFAULT_VEHICLE_VOLUME_CAPACITY = 2; // m^3
        const DEFAULT_VEHICLE_MAX_DISTANCE = 100000; // meters
        const DEFAULT_VEHICLE_MAX_HOURS = 8; // hours
        const REQUEST_TIMEOUT = 5000; // ms
        const SERVICE_TOKEN = 'SERVICE_TOKEN_PLACEHOLDER';

        // Use pickup coordinates - require them to be present
        if (!data.pickup.coordinates?.latitude || !data.pickup.coordinates?.longitude) {
          throw new Error('Pickup coordinates are required for route optimization');
        }

        const pickupLat = data.pickup.coordinates.latitude;
        const pickupLng = data.pickup.coordinates.longitude;

        try {
          const driversResponse = await axios.get(`${LOGISTICS_SERVICE_URL}/api/logistics/nearby-drivers`, {
            params: {
              latitude: pickupLat,
              longitude: pickupLng,
              radius: DRIVER_SEARCH_RADIUS,
              limit: MAX_DRIVERS_PER_ORDER
            },
            headers: {
              'Content-Type': 'application/json',
              'X-Service-Token': SERVICE_TOKEN
            },
            timeout: REQUEST_TIMEOUT
          });
          
          // Transform drivers to vehicle format
          const nearbyDrivers = driversResponse.data.data || [];
          availableVehicles = nearbyDrivers.map(driver => ({
            id: `driver-${driver.driver_id}`,
            startLocation: {
              latitude: driver.latitude,
              longitude: driver.longitude
            },
            baseLocation: {
              latitude: driver.latitude,
              longitude: driver.longitude
            },
            capacity: { 
              weight: DEFAULT_VEHICLE_WEIGHT_CAPACITY,
              volume: DEFAULT_VEHICLE_VOLUME_CAPACITY
            },
            maxDistance: DEFAULT_VEHICLE_MAX_DISTANCE,
            maxWorkingHours: DEFAULT_VEHICLE_MAX_HOURS,
            skills: []
          }));
          
        } catch (driverError) {
          logger.error('Failed to fetch nearby drivers from logistics service:', driverError.message);
          throw new Error('Failed to fetch nearby drivers for route optimization');
        }
        
        if (availableVehicles.length === 0) {
          throw new Error('No available drivers for route optimization');
        }

        // Calculate service time based on order items
        const totalItems = data.items ? data.items.reduce((sum, item) => sum + item.quantity, 0) : 1;
        const serviceTime = Math.max(180, Math.min(600, totalItems * 60)); // 3-10 minutes based on items

        // Transform order data to route optimization request
        const routeRequest = {
          id: data.correlationId || `route-${Date.now()}`,
          profile: data.priority === 'urgent' ? 'fastest' : 'balanced',
          stops: [
            {
              id: `pickup-${data.orderId}`,
              address: data.pickup.address,
              coordinates: data.pickup.coordinates || null,
              type: 'pickup',
              serviceTime,
              priority: data.priority === 'urgent' ? 3 : (data.priority === 'express' ? 2 : 1),
              timeWindows: data.pickup.scheduledTime ? [{
                start: new Date(data.pickup.scheduledTime).toISOString(),
                end: new Date(new Date(data.pickup.scheduledTime).getTime() + 3600000).toISOString()
              }] : []
            },
            {
              id: `delivery-${data.orderId}`,
              address: data.delivery.address,
              coordinates: data.delivery.coordinates || null,
              type: 'delivery',
              serviceTime,
              priority: data.priority === 'urgent' ? 3 : (data.priority === 'express' ? 2 : 1),
              timeWindows: data.delivery.estimatedTime ? [{
                start: new Date(data.delivery.estimatedTime).toISOString(),
                end: new Date(new Date(data.delivery.estimatedTime).getTime() + 3600000).toISOString()
              }] : []
            }
          ],
          vehicles: availableVehicles.map(vehicle => ({
            id: vehicle.id,
            startLocation: vehicle.currentLocation || vehicle.baseLocation,
            endLocation: vehicle.baseLocation,
            capacity: vehicle.capacity,
            maxDistance: vehicle.maxDistance || 50000,
            maxTime: vehicle.maxWorkingHours ? vehicle.maxWorkingHours * 3600 : 28800,
            skills: vehicle.skills || []
          })),
          considerTraffic: true,
          optimizeOrder: true,
          balanceRoutes: availableVehicles.length > 1,
          returnToDepot: true
        };

        // Call route optimization
        const optimizedRoute = await ROSAdapter.optimizeRoute(routeRequest);
        
        // Publish route.optimized event
        await messageBroker.publish(
          messageBroker.exchanges.LOGISTICS,
          'route.optimized',
          {
            orderId: data.orderId,
            routeId: routeRequest.id,
            optimized: optimizedRoute.optimized,
            totalDistance: optimizedRoute.totalDistance,
            totalDuration: optimizedRoute.totalDuration,
            totalCost: optimizedRoute.totalCost,
            routes: optimizedRoute.routes,
            provider: optimizedRoute.metadata.provider,
            timestamp: new Date().toISOString(),
            correlationId: data.correlationId
          }
        );

        logger.info('Route optimization completed for order:', {
          orderId: data.orderId,
          routeId: routeRequest.id,
          provider: optimizedRoute.metadata.provider,
          optimized: optimizedRoute.optimized,
          totalDistance: optimizedRoute.totalDistance,
          totalDuration: optimizedRoute.totalDuration
        });

      } catch (error) {
        logger.error('Failed to optimize route for order:', {
          orderId: data.orderId,
          error: error.message
        });
        
        // Publish failed optimization event
        await messageBroker.publish(
          messageBroker.exchanges.LOGISTICS,
          'route.optimization.failed',
          {
            orderId: data.orderId,
            error: error.message,
            timestamp: new Date().toISOString(),
            correlationId: data.correlationId
          }
        );
      }
    }
  );

  // Bind queues to exchanges
  await messageBroker.bindQueue(
    'order.created.ros',
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
