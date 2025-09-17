require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const logger = require('../../shared/logger');
const { validateRequest, validateQuery } = require('../../shared/validation');
const { asyncHandler, errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');

const app = express();
const PORT = process.env.PORT || 3003;

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

mongoose.connection.on('connected', () => {
  logger.info('Order Service: Connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  logger.error('Order Service: MongoDB connection error:', err);
});

// Middleware
app.use(express.json());

// Order Schema
const orderSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => `ord-${uuidv4().substring(0, 8)}`
  },
  clientId: {
    type: String,
    required: true,
    index: true
  },
  driverId: {
    type: String,
    index: true
  },
  pickupAddress: {
    type: String,
    required: true
  },
  deliveryAddress: {
    type: String,
    required: true
  },
  items: [{
    name: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    weight: {
      type: Number,
      min: 0
    },
    dimensions: {
      length: Number,
      width: Number,
      height: Number
    }
  }],
  contactPhone: {
    type: String,
    required: true
  },
  notes: {
    type: String,
    maxlength: 500
  },
  status: {
    type: String,
    enum: ['created', 'assigned', 'accepted', 'en_route_pickup', 'arrived_pickup', 
           'picked_up', 'en_route_delivery', 'arrived_delivery', 'delivered', 'cancelled'],
    default: 'created',
    index: true
  },
  priority: {
    type: String,
    enum: ['standard', 'express', 'urgent'],
    default: 'standard'
  },
  scheduledPickup: {
    type: Date
  },
  estimatedDelivery: {
    type: Date
  },
  actualPickup: {
    type: Date
  },
  actualDelivery: {
    type: Date
  },
  route: [{
    address: String,
    type: {
      type: String,
      enum: ['pickup', 'delivery']
    },
    completed: {
      type: Boolean,
      default: false
    },
    timestamp: Date,
    location: {
      latitude: Number,
      longitude: Number
    }
  }],
  tracking: [{
    status: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    location: {
      latitude: Number,
      longitude: Number
    },
    notes: String,
    updatedBy: String
  }],
  proofOfDelivery: {
    url: String,
    timestamp: Date,
    notes: String
  },
  totalCost: {
    type: Number,
    min: 0
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ clientId: 1, createdAt: -1 });
orderSchema.index({ driverId: 1, status: 1 });

const Order = mongoose.model('Order', orderSchema);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'order-service',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Routes

/**
 * @swagger
 * /api/orders:
 *   post:
 *     summary: Create a new order
 *     tags: [Orders]
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
 *               - items
 *               - contactPhone
 *             properties:
 *               pickupAddress:
 *                 type: string
 *               deliveryAddress:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     quantity:
 *                       type: integer
 *                     weight:
 *                       type: number
 *               contactPhone:
 *                 type: string
 *               notes:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [standard, express, urgent]
 *               scheduledPickup:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Order created successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
app.post('/api/orders',
  validateRequest(require('../../shared/validation').schemas.createOrder),
  asyncHandler(async (req, res) => {
    const clientId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    
    if (!clientId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    if (userRole !== 'client' && userRole !== 'admin') {
      return res.status(403).json({ error: 'Only clients can create orders' });
    }

    // Create order
    const orderData = {
      ...req.body,
      clientId,
      route: [
        {
          address: req.body.pickupAddress,
          type: 'pickup',
          completed: false
        },
        {
          address: req.body.deliveryAddress,
          type: 'delivery',
          completed: false
        }
      ],
      tracking: [{
        status: 'created',
        timestamp: new Date(),
        notes: 'Order created',
        updatedBy: clientId
      }]
    };

    const order = new Order(orderData);
    await order.save();

    // Publish order created event
    await messageBroker.publish(
      messageBroker.exchanges.ORDERS,
      'order.created',
      {
        orderId: order._id,
        clientId: order.clientId,
        pickupAddress: order.pickupAddress,
        deliveryAddress: order.deliveryAddress,
        priority: order.priority,
        timestamp: new Date().toISOString()
      }
    );

    logger.info('Order created:', { orderId: order._id, clientId });

    res.status(201).json({
      success: true,
      data: order
    });
  })
);

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: Get orders (filtered by user role)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by order status
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of orders per page
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *       401:
 *         description: Unauthorized
 */
app.get('/api/orders',
  validateQuery(require('../../shared/validation').schemas.orderQuery),
  asyncHandler(async (req, res) => {
    const userId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const { status, startDate, endDate, page, limit, sortBy, sortOrder } = req.query;
    
    // Build query based on user role
    let query = {};
    
    if (userRole === 'client') {
      query.clientId = userId;
    } else if (userRole === 'driver') {
      query.driverId = userId;
    }
    // Admin can see all orders (no additional filter)

    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Pagination
    const skip = (page - 1) * limit;
    const sort = {};
    if (sortBy) {
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sort.createdAt = -1;
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  })
);

/**
 * @swagger
 * /api/orders/{id}:
 *   get:
 *     summary: Get order by ID
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     responses:
 *       200:
 *         description: Order retrieved successfully
 *       404:
 *         description: Order not found
 *       403:
 *         description: Access denied
 */
app.get('/api/orders/:id', asyncHandler(async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'];
  const { id } = req.params;
  
  if (!userId) {
    return res.status(401).json({ error: 'User ID required' });
  }

  const order = await Order.findById(id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // Check permissions
  if (userRole === 'client' && order.clientId !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  if (userRole === 'driver' && order.driverId !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({
    success: true,
    data: order
  });
}));

/**
 * @swagger
 * /api/orders/{id}/status:
 *   patch:
 *     summary: Update order status
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [created, assigned, accepted, en_route_pickup, arrived_pickup, picked_up, en_route_delivery, arrived_delivery, delivered, cancelled]
 *               location:
 *                 type: object
 *                 properties:
 *                   latitude:
 *                     type: number
 *                   longitude:
 *                     type: number
 *               notes:
 *                 type: string
 *               proofUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Order status updated successfully
 *       404:
 *         description: Order not found
 *       403:
 *         description: Access denied
 */
app.patch('/api/orders/:id/status',
  validateRequest(require('../../shared/validation').schemas.updateOrderStatus),
  asyncHandler(async (req, res) => {
    const userId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    const { id } = req.params;
    const { status, location, notes, proofUrl } = req.body;
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check permissions - only drivers and admins can update status
    if (userRole === 'driver' && order.driverId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (userRole === 'client') {
      return res.status(403).json({ error: 'Clients cannot update order status' });
    }

    // Update order status
    order.status = status;
    
    // Add tracking entry
    order.tracking.push({
      status,
      timestamp: new Date(),
      location,
      notes,
      updatedBy: userId
    });

    // Update route completion based on status
    if (status === 'picked_up') {
      const pickupRoute = order.route.find(r => r.type === 'pickup');
      if (pickupRoute) {
        pickupRoute.completed = true;
        pickupRoute.timestamp = new Date();
        pickupRoute.location = location;
      }
      order.actualPickup = new Date();
    } else if (status === 'delivered') {
      const deliveryRoute = order.route.find(r => r.type === 'delivery');
      if (deliveryRoute) {
        deliveryRoute.completed = true;
        deliveryRoute.timestamp = new Date();
        deliveryRoute.location = location;
      }
      order.actualDelivery = new Date();
      
      if (proofUrl) {
        order.proofOfDelivery = {
          url: proofUrl,
          timestamp: new Date(),
          notes
        };
      }
    }

    await order.save();

    // Publish order status updated event
    await messageBroker.publish(
      messageBroker.exchanges.ORDERS,
      'order.status.updated',
      {
        orderId: order._id,
        clientId: order.clientId,
        driverId: order.driverId,
        status,
        previousStatus: order.tracking[order.tracking.length - 2]?.status,
        location,
        timestamp: new Date().toISOString()
      }
    );

    logger.info('Order status updated:', { orderId: order._id, status, updatedBy: userId });

    res.json({
      success: true,
      data: order
    });
  })
);

/**
 * @swagger
 * /api/orders/{id}/assign:
 *   patch:
 *     summary: Assign order to driver
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - driverId
 *             properties:
 *               driverId:
 *                 type: string
 *               estimatedPickup:
 *                 type: string
 *                 format: date-time
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Order assigned successfully
 *       404:
 *         description: Order not found
 *       403:
 *         description: Access denied
 */
app.patch('/api/orders/:id/assign', asyncHandler(async (req, res) => {
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'];
  const { id } = req.params;
  const { driverId, estimatedPickup, estimatedDelivery } = req.body;
  
  if (userRole !== 'admin') {
    return res.status(403).json({ error: 'Only admins can assign orders' });
  }

  const order = await Order.findById(id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (order.status !== 'created') {
    return res.status(400).json({ error: 'Order cannot be assigned in current status' });
  }

  // Assign order
  order.driverId = driverId;
  order.status = 'assigned';
  if (estimatedPickup) order.scheduledPickup = new Date(estimatedPickup);
  if (estimatedDelivery) order.estimatedDelivery = new Date(estimatedDelivery);

  order.tracking.push({
    status: 'assigned',
    timestamp: new Date(),
    notes: `Assigned to driver ${driverId}`,
    updatedBy: userId
  });

  await order.save();

  // Publish driver assigned event
  await messageBroker.publish(
    messageBroker.exchanges.ORDERS,
    'driver.assigned',
    {
      orderId: order._id,
      driverId,
      clientId: order.clientId,
      estimatedPickup,
      estimatedDelivery,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Order assigned:', { orderId: order._id, driverId, assignedBy: userId });

  res.json({
    success: true,
    data: order
  });
}));

// Message broker event handlers
async function setupEventHandlers() {
  // Handle user created events to update order references
  await messageBroker.subscribe(
    messageBroker.queues.USER_CREATED,
    async (data) => {
      logger.info('User created event received:', data);
      // Could update any cached user data if needed
    }
  );

  // Bind queues to exchanges
  await messageBroker.bindQueue(
    messageBroker.queues.USER_CREATED,
    messageBroker.exchanges.USERS,
    'user.created'
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
      logger.info(`Order Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start Order Service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await messageBroker.close();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await messageBroker.close();
  await mongoose.connection.close();
  process.exit(0);
});

startServer();

module.exports = app;
