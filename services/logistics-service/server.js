require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');

const logger = require('../../shared/logger');
const { validateRequest, validateQuery } = require('../../shared/validation');
const { asyncHandler, errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');

const app = express();
const PORT = process.env.PORT || 3004;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Test connections
pool.connect()
  .then(() => logger.info('Logistics Service: Connected to PostgreSQL'))
  .catch(err => logger.error('Logistics Service: PostgreSQL connection error:', err));

redisClient.connect()
  .then(() => logger.info('Logistics Service: Connected to Redis'))
  .catch(err => logger.error('Logistics Service: Redis connection error:', err));

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
    service: 'logistics-service'
  });
});

// Driver model functions
const DriverModel = {
  async getDriverOrders(driverId) {
    const query = `
      SELECT dro.*, o.pickup_address, o.delivery_address, o.contact_phone, o.priority
      FROM driver_orders dro
      JOIN orders o ON dro.order_id = o.id
      WHERE dro.driver_id = $1
      ORDER BY dro.assigned_at DESC
    `;
    const result = await pool.query(query, [driverId]);
    return result.rows;
  },

  async assignOrder(driverId, orderId, estimatedPickup = null, estimatedDelivery = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert driver assignment
      const assignQuery = `
        INSERT INTO driver_orders (driver_id, order_id, status, assigned_at, estimated_pickup, estimated_delivery)
        VALUES ($1, $2, 'assigned', NOW(), $3, $4)
        ON CONFLICT (driver_id, order_id) 
        DO UPDATE SET status = 'assigned', assigned_at = NOW()
        RETURNING *
      `;
      
      const assignResult = await client.query(assignQuery, [driverId, orderId, estimatedPickup, estimatedDelivery]);

      // Update orders table
      const orderQuery = `
        INSERT INTO orders (id, driver_id, status, updated_at)
        VALUES ($1, $2, 'assigned', NOW())
        ON CONFLICT (id)
        DO UPDATE SET driver_id = $2, status = 'assigned', updated_at = NOW()
      `;
      
      await client.query(orderQuery, [orderId, driverId]);

      await client.query('COMMIT');
      return assignResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async acceptOrder(driverId, orderId) {
    const query = `
      UPDATE driver_orders 
      SET status = 'accepted', accepted_at = NOW()
      WHERE driver_id = $1 AND order_id = $2
      RETURNING *
    `;
    const result = await pool.query(query, [driverId, orderId]);
    return result.rows[0];
  },

  async updateLocation(driverId, latitude, longitude, heading = null, speed = null) {
    const locationData = {
      driverId,
      latitude,
      longitude,
      heading,
      speed,
      timestamp: new Date().toISOString()
    };

    // Store in Redis for real-time tracking
    await redisClient.setEx(`driver:location:${driverId}`, 300, JSON.stringify(locationData)); // 5 min TTL

    // Store in PostgreSQL for historical data
    const query = `
      INSERT INTO driver_locations (driver_id, latitude, longitude, heading, speed, recorded_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `;
    await pool.query(query, [driverId, latitude, longitude, heading, speed]);

    return locationData;
  },

  async getDriverLocation(driverId) {
    try {
      const cachedLocation = await redisClient.get(`driver:location:${driverId}`);
      if (cachedLocation) {
        return JSON.parse(cachedLocation);
      }
    } catch (error) {
      logger.warn('Redis error, falling back to PostgreSQL:', error);
    }

    // Fallback to PostgreSQL
    const query = `
      SELECT * FROM driver_locations 
      WHERE driver_id = $1 
      ORDER BY recorded_at DESC 
      LIMIT 1
    `;
    const result = await pool.query(query, [driverId]);
    return result.rows[0];
  },

  async getNearbyDrivers(latitude, longitude, radiusKm = 10, limit = 10) {
    // This is a simplified version. In production, you'd use PostGIS for proper geospatial queries
    const query = `
      SELECT DISTINCT dl.driver_id, dl.latitude, dl.longitude, dl.recorded_at,
        (6371 * acos(cos(radians($1)) * cos(radians(dl.latitude)) * 
         cos(radians(dl.longitude) - radians($2)) + 
         sin(radians($1)) * sin(radians(dl.latitude)))) AS distance
      FROM driver_locations dl
      INNER JOIN (
        SELECT driver_id, MAX(recorded_at) as max_time
        FROM driver_locations
        WHERE recorded_at > NOW() - INTERVAL '1 hour'
        GROUP BY driver_id
      ) recent ON dl.driver_id = recent.driver_id AND dl.recorded_at = recent.max_time
      WHERE (6371 * acos(cos(radians($1)) * cos(radians(dl.latitude)) * 
             cos(radians(dl.longitude) - radians($2)) + 
             sin(radians($1)) * sin(radians(dl.latitude)))) < $3
      ORDER BY distance
      LIMIT $4
    `;
    
    const result = await pool.query(query, [latitude, longitude, radiusKm, limit]);
    return result.rows;
  }
};

// ROS Adapter client
const axios = require('axios');
const rosClient = axios.create({
  baseURL: process.env.ROS_ADAPTER_URL || 'http://localhost:3007',
  timeout: 30000
});

// Route optimization functions - delegates to ROS adapter
const RouteOptimizer = {
  async optimizeRoute(pickupAddress, deliveryAddress, options = {}) {
    try {
      const routeRequest = {
        stops: [
          {
            id: 'pickup',
            address: pickupAddress,
            type: 'pickup',
            coordinates: options.pickupCoordinates
          },
          {
            id: 'delivery', 
            address: deliveryAddress,
            type: 'delivery',
            coordinates: options.deliveryCoordinates
          }
        ],
        vehicles: [{
          id: 'vehicle-1',
          startLocation: options.pickupCoordinates || { latitude: 0, longitude: 0 },
          capacity: options.capacity || {}
        }],
        profile: options.profile || 'balanced',
        considerTraffic: options.considerTraffic !== false
      };

      const response = await rosClient.post('/api/ros/optimize', routeRequest);
      
      if (response.data.success) {
        return response.data.data;
      } else {
        throw new Error('ROS optimization failed');
      }
    } catch (error) {
      logger.error('Route optimization via ROS adapter failed:', error);
      throw new Error(`Route optimization failed: ${error.message}`);
    }
  },

  async calculateETA(currentLocation, destinationAddress, options = {}) {
    try {
      const etaRequest = {
        origin: currentLocation,
        destination: destinationAddress,
        options
      };

      const response = await rosClient.post('/api/ros/eta', etaRequest);
      
      if (response.data.success) {
        return response.data.data;
      } else {
        throw new Error('ROS ETA calculation failed');
      }
    } catch (error) {
      logger.error('ETA calculation via ROS adapter failed:', error);
      throw new Error(`ETA calculation failed: ${error.message}`);
    }
  }
};

// Routes

/**
 * @swagger
 * /api/drivers/{driverId}/orders:
 *   get:
 *     summary: Get orders assigned to driver
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: driverId
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *     responses:
 *       200:
 *         description: Driver orders retrieved successfully
 *       403:
 *         description: Access denied
 */
app.get('/api/drivers/:driverId/orders', asyncHandler(async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'];
  const { driverId } = req.params;
  
  if (userRole === 'driver' && userId !== driverId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const orders = await DriverModel.getDriverOrders(driverId);

  res.json({
    success: true,
    data: orders
  });
}));

/**
 * @swagger
 * /api/drivers/{driverId}/orders/{orderId}/accept:
 *   post:
 *     summary: Accept an assigned order
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: driverId
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               estimatedArrival:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Order accepted successfully
 *       403:
 *         description: Access denied
 *       404:
 *         description: Order not found
 */
app.post('/api/drivers/:driverId/orders/:orderId/accept',
  validateRequest(require('../../shared/validation').schemas.acceptOrder),
  asyncHandler(async (req, res) => {
    const userId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    const { driverId, orderId } = req.params;
    
    if (userRole === 'driver' && userId !== driverId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const assignment = await DriverModel.acceptOrder(driverId, orderId);
    if (!assignment) {
      return res.status(404).json({ error: 'Order assignment not found' });
    }

    // Publish order accepted event
    await messageBroker.publish(
      messageBroker.exchanges.LOGISTICS,
      'order.accepted',
      {
        orderId,
        driverId,
        acceptedAt: new Date().toISOString(),
        estimatedArrival: req.body.estimatedArrival
      }
    );

    logger.info('Order accepted:', { orderId, driverId });

    res.json({
      success: true,
      data: assignment
    });
  })
);

/**
 * @swagger
 * /api/drivers/{driverId}/location:
 *   post:
 *     summary: Update driver location
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: driverId
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - latitude
 *               - longitude
 *             properties:
 *               latitude:
 *                 type: number
 *                 minimum: -90
 *                 maximum: 90
 *               longitude:
 *                 type: number
 *                 minimum: -180
 *                 maximum: 180
 *               heading:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 360
 *               speed:
 *                 type: number
 *                 minimum: 0
 *     responses:
 *       200:
 *         description: Location updated successfully
 *       403:
 *         description: Access denied
 */
app.post('/api/drivers/:driverId/location',
  validateRequest(require('../../shared/validation').schemas.updateLocation),
  asyncHandler(async (req, res) => {
    const userId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    const { driverId } = req.params;
    const { latitude, longitude, heading, speed } = req.body;
    
    if (userRole === 'driver' && userId !== driverId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const locationData = await DriverModel.updateLocation(driverId, latitude, longitude, heading, speed);

    // Publish location update event
    await messageBroker.publish(
      messageBroker.exchanges.LOGISTICS,
      'driver.location.updated',
      {
        driverId,
        location: {
          latitude,
          longitude,
          heading,
          speed
        },
        timestamp: locationData.timestamp
      }
    );

    res.json({
      success: true,
      data: locationData
    });
  })
);

/**
 * @swagger
 * /api/drivers/{driverId}/location:
 *   get:
 *     summary: Get driver's current location
 *     tags: [Drivers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: driverId
 *         required: true
 *         schema:
 *           type: string
 *         description: Driver ID
 *     responses:
 *       200:
 *         description: Driver location retrieved successfully
 *       404:
 *         description: Location not found
 */
app.get('/api/drivers/:driverId/location', asyncHandler(async (req, res) => {
  const { driverId } = req.params;
  
  const location = await DriverModel.getDriverLocation(driverId);
  if (!location) {
    return res.status(404).json({ error: 'Driver location not found' });
  }

  res.json({
    success: true,
    data: location
  });
}));

/**
 * @swagger
 * /api/logistics/nearby-drivers:
 *   get:
 *     summary: Find nearby drivers
 *     tags: [Logistics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: latitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Latitude of the location
 *       - in: query
 *         name: longitude
 *         required: true
 *         schema:
 *           type: number
 *         description: Longitude of the location
 *       - in: query
 *         name: radius
 *         schema:
 *           type: number
 *           default: 10
 *         description: Search radius in kilometers
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of drivers to return
 *     responses:
 *       200:
 *         description: Nearby drivers found
 *       400:
 *         description: Invalid coordinates
 */
app.get('/api/logistics/nearby-drivers', asyncHandler(async (req, res) => {
  const { latitude, longitude, radius = 10, limit = 10 } = req.query;
  
  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'Latitude and longitude are required' });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const drivers = await DriverModel.getNearbyDrivers(lat, lng, parseInt(radius), parseInt(limit));

  res.json({
    success: true,
    data: drivers
  });
}));

/**
 * @swagger
 * /api/logistics/optimize-route:
 *   post:
 *     summary: Optimize route for pickup and delivery
 *     tags: [Logistics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pickupAddress
 *               - deliveryAddress
 *             properties:
 *               pickupAddress:
 *                 type: string
 *               deliveryAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Route optimized successfully
 *       400:
 *         description: Invalid addresses
 */
app.post('/api/logistics/optimize-route', asyncHandler(async (req, res) => {
  const { pickupAddress, deliveryAddress } = req.body;
  
  if (!pickupAddress || !deliveryAddress) {
    return res.status(400).json({ error: 'Pickup and delivery addresses are required' });
  }

  const optimizedRoute = await RouteOptimizer.optimizeRoute(pickupAddress, deliveryAddress);

  res.json({
    success: true,
    data: optimizedRoute
  });
}));

/**
 * @swagger
 * /api/logistics/eta:
 *   post:
 *     summary: Calculate ETA to destination
 *     tags: [Logistics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentLocation
 *               - destinationAddress
 *             properties:
 *               currentLocation:
 *                 type: object
 *                 properties:
 *                   latitude:
 *                     type: number
 *                   longitude:
 *                     type: number
 *               destinationAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: ETA calculated successfully
 */
app.post('/api/logistics/eta', asyncHandler(async (req, res) => {
  const { currentLocation, destinationAddress } = req.body;
  
  if (!currentLocation || !destinationAddress) {
    return res.status(400).json({ error: 'Current location and destination address are required' });
  }

  const eta = await RouteOptimizer.calculateETA(currentLocation, destinationAddress);

  res.json({
    success: true,
    data: eta
  });
}));

// Message broker event handlers
async function setupEventHandlers() {
  // Handle order created events for automatic driver assignment
  await messageBroker.subscribe(
    'order.created.logistics',
    async (data) => {
      logger.info('Order created event received:', data);
      
      // Find nearby drivers and auto-assign
      // This is a simplified version - in production you'd have more sophisticated assignment logic
      // const nearbyDrivers = await DriverModel.getNearbyDrivers(
      //   data.pickupLatitude, 
      //   data.pickupLongitude, 
      //   20, 
      //   1
      // );
      
      // if (nearbyDrivers.length > 0) {
      //   await DriverModel.assignOrder(nearbyDrivers[0].driver_id, data.orderId);
      // }
    }
  );

  // Bind queues to exchanges
  await messageBroker.bindQueue(
    'order.created.logistics',
    messageBroker.exchanges.ORDERS,
    'order.created'
  );
}

// Error handling
app.use(notFound);
app.use(errorHandler);

// Initialize message broker and start server
async function startServer() {
  try {
    await messageBroker.connect();
    await setupEventHandlers();
    
    app.listen(PORT, () => {
      logger.info(`Logistics Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start Logistics Service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await messageBroker.close();
  await redisClient.quit();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await messageBroker.close();
  await redisClient.quit();
  await pool.end();
  process.exit(0);
});

startServer();

module.exports = app;
