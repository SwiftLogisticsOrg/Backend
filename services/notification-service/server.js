require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const morgan = require('morgan');

const logger = require('../../shared/logger');
const { errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3005;

// Socket.IO setup with CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Email transporter setup (optional)
let emailTransporter = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
  
  logger.info('Email transporter configured');
} else {
  logger.warn('Email configuration not provided - email notifications disabled');
}

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
    service: 'notification-service',
    connectedClients: io.engine.clientsCount
  });
});

// Socket connection management
const connectedUsers = new Map(); // userId -> socket mapping
const userRoles = new Map(); // userId -> role mapping

// Socket authentication middleware
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication token required'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    socket.userRole = decoded.role;
    socket.userEmail = decoded.email;
    
    logger.debug('Socket authenticated:', { userId: decoded.id, role: decoded.role });
    next();
  } catch (error) {
    logger.warn('Socket authentication failed:', error.message);
    next(new Error('Authentication failed'));
  }
});

// Socket connection handling
io.on('connection', (socket) => {
  const { userId, userRole, userEmail } = socket;
  
  // Store user connection
  connectedUsers.set(userId, socket);
  userRoles.set(userId, userRole);
  
  logger.info('User connected:', { userId, userRole, socketId: socket.id });

  // Join user to their personal room
  socket.join(`user:${userId}`);
  
  // Join role-based rooms
  socket.join(`role:${userRole}`);
  
  // If driver, join driver-specific room
  if (userRole === 'driver') {
    socket.join('drivers');
  }

  // Handle location updates from drivers
  socket.on('location:update', (locationData) => {
    if (userRole === 'driver') {
      // Broadcast location update to all clients tracking this driver
      socket.to('clients').emit('driver:location', {
        driverId: userId,
        location: locationData,
        timestamp: new Date().toISOString()
      });
      
      logger.debug('Driver location updated:', { userId, location: locationData });
    }
  });

  // Handle order tracking subscription
  socket.on('track:order', (orderId) => {
    socket.join(`order:${orderId}`);
    logger.debug('User subscribed to order tracking:', { userId, orderId });
  });

  // Handle order tracking unsubscription
  socket.on('untrack:order', (orderId) => {
    socket.leave(`order:${orderId}`);
    logger.debug('User unsubscribed from order tracking:', { userId, orderId });
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    connectedUsers.delete(userId);
    userRoles.delete(userId);
    logger.info('User disconnected:', { userId, userRole, reason });
  });

  // Send welcome message
  socket.emit('connected', {
    message: 'Connected to SwiftTrack notifications',
    userId,
    userRole,
    timestamp: new Date().toISOString()
  });
});

// Notification functions
const NotificationService = {
  // Send real-time notification via Socket.IO
  async sendRealTimeNotification(userId, event, data) {
    const socket = connectedUsers.get(userId);
    if (socket) {
      socket.emit(event, {
        ...data,
        timestamp: new Date().toISOString()
      });
      logger.debug('Real-time notification sent:', { userId, event });
      return true;
    }
    return false;
  },

  // Broadcast to all users with specific role
  async broadcastToRole(role, event, data) {
    io.to(`role:${role}`).emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
    logger.debug('Broadcast to role:', { role, event });
  },

  // Broadcast to order tracking room
  async broadcastToOrder(orderId, event, data) {
    io.to(`order:${orderId}`).emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
    logger.debug('Broadcast to order:', { orderId, event });
  },

  // Send email notification
  async sendEmailNotification(to, subject, text, html = null) {
    if (!emailTransporter) {
      logger.warn('Email notification skipped - transporter not configured');
      return false;
    }

    try {
      const mailOptions = {
        from: process.env.EMAIL_FROM,
        to,
        subject,
        text,
        html: html || text
      };

      await emailTransporter.sendMail(mailOptions);
      logger.info('Email notification sent:', { to, subject });
      return true;
    } catch (error) {
      logger.error('Email notification failed:', error);
      return false;
    }
  },

  // Send push notification (placeholder for future implementation)
  async sendPushNotification(userId, title, body, data = {}) {
    // Placeholder for push notification service integration
    // (Firebase FCM, Apple Push Notification Service, etc.)
    logger.debug('Push notification placeholder:', { userId, title, body });
    return true;
  }
};

// Message broker event handlers
async function setupEventHandlers() {
  // Handle order status updates
  await messageBroker.subscribe(
    'order.status.updated',
    async (data) => {
      const { orderId, clientId, driverId, status, location } = data;
      
      // Notify client about order status update
      await NotificationService.sendRealTimeNotification(clientId, 'order:status:updated', {
        orderId,
        status,
        location,
        message: `Your order status has been updated to: ${status}`
      });

      // Broadcast to order tracking room
      await NotificationService.broadcastToOrder(orderId, 'order:status:updated', {
        orderId,
        status,
        location
      });

      // Send email notification for important status changes
      if (['delivered', 'cancelled'].includes(status)) {
        // Note: In a real implementation, you'd fetch user email from user service
        await NotificationService.sendEmailNotification(
          'client@example.com', // Replace with actual client email
          `Order ${status}`,
          `Your order ${orderId} has been ${status}.`
        );
      }

      logger.info('Order status notification sent:', { orderId, status });
    }
  );

  // Handle driver assignments
  await messageBroker.subscribe(
    'driver.assigned',
    async (data) => {
      const { orderId, driverId, clientId } = data;
      
      // Notify driver about new assignment
      await NotificationService.sendRealTimeNotification(driverId, 'order:assigned', {
        orderId,
        message: 'You have been assigned a new order',
        data
      });

      // Notify client about driver assignment
      await NotificationService.sendRealTimeNotification(clientId, 'driver:assigned', {
        orderId,
        driverId,
        message: 'A driver has been assigned to your order'
      });

      logger.info('Driver assignment notification sent:', { orderId, driverId });
    }
  );

  // Handle order creation notifications
  await messageBroker.subscribe(
    'order.created.notifications',
    async (data) => {
      const { orderId, clientId, priority } = data;
      
      // Notify available drivers about new order (for express/urgent orders)
      if (['express', 'urgent'].includes(priority)) {
        await NotificationService.broadcastToRole('driver', 'order:available', {
          orderId,
          priority,
          message: `New ${priority} order available`
        });
      }

      // Send confirmation to client
      await NotificationService.sendRealTimeNotification(clientId, 'order:created', {
        orderId,
        message: 'Your order has been created successfully'
      });

      logger.info('Order creation notification sent:', { orderId, priority });
    }
  );

  // Handle driver location updates
  await messageBroker.subscribe(
    'driver.location.updated',
    async (data) => {
      const { driverId, location } = data;
      
      // Broadcast location update to clients tracking this driver's orders
      // Note: In a real implementation, you'd query which orders this driver is handling
      // and notify the respective clients
      io.emit('driver:location:updated', {
        driverId,
        location
      });

      logger.debug('Driver location update broadcasted:', { driverId });
    }
  );

  // Bind queues to exchanges
  await messageBroker.bindQueue('order.status.updated', messageBroker.exchanges.ORDERS, 'order.status.updated');
  await messageBroker.bindQueue('driver.assigned', messageBroker.exchanges.ORDERS, 'driver.assigned');
  await messageBroker.bindQueue('order.created.notifications', messageBroker.exchanges.ORDERS, 'order.created');
  await messageBroker.bindQueue('driver.location.updated', messageBroker.exchanges.LOGISTICS, 'driver.location.updated');
}

// REST API endpoints for external notifications

/**
 * @swagger
 * /api/notifications/send:
 *   post:
 *     summary: Send notification to user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - event
 *               - data
 *             properties:
 *               userId:
 *                 type: string
 *               event:
 *                 type: string
 *               data:
 *                 type: object
 *               email:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Notification sent successfully
 *       400:
 *         description: Invalid request
 */
app.post('/api/notifications/send', async (req, res) => {
  const { userId, event, data, email = false } = req.body;
  
  if (!userId || !event || !data) {
    return res.status(400).json({ error: 'userId, event, and data are required' });
  }

  const success = await NotificationService.sendRealTimeNotification(userId, event, data);
  
  res.json({
    success: true,
    delivered: success,
    timestamp: new Date().toISOString()
  });
});

/**
 * @swagger
 * /api/notifications/broadcast:
 *   post:
 *     summary: Broadcast notification to role
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role
 *               - event
 *               - data
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [client, driver, admin]
 *               event:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Broadcast sent successfully
 */
app.post('/api/notifications/broadcast', async (req, res) => {
  const { role, event, data } = req.body;
  
  if (!role || !event || !data) {
    return res.status(400).json({ error: 'role, event, and data are required' });
  }

  await NotificationService.broadcastToRole(role, event, data);
  
  res.json({
    success: true,
    timestamp: new Date().toISOString()
  });
});

/**
 * @swagger
 * /api/notifications/stats:
 *   get:
 *     summary: Get notification service stats
 *     tags: [Notifications]
 *     responses:
 *       200:
 *         description: Stats retrieved successfully
 */
app.get('/api/notifications/stats', (req, res) => {
  res.json({
    success: true,
    data: {
      connectedUsers: connectedUsers.size,
      totalConnections: io.engine.clientsCount,
      usersByRole: {
        client: Array.from(userRoles.values()).filter(role => role === 'client').length,
        driver: Array.from(userRoles.values()).filter(role => role === 'driver').length,
        admin: Array.from(userRoles.values()).filter(role => role === 'admin').length
      }
    }
  });
});

// Error handling
app.use(notFound);
app.use(errorHandler);

// Initialize message broker and start server
async function startServer() {
  try {
    await messageBroker.connect();
    await setupEventHandlers();
    
    server.listen(PORT, () => {
      logger.info(`Notification Service running on port ${PORT}`);
      logger.info(`WebSocket server ready for connections`);
    });
  } catch (error) {
    logger.error('Failed to start Notification Service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await messageBroker.close();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await messageBroker.close();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

startServer();

module.exports = { app, io };
