require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const morgan = require('morgan');

const logger = require('../shared/logger');
const { authenticateToken, authorizeRole } = require('../shared/auth');
const { errorHandler, notFound } = require('../shared/errorHandler');

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(compression());

// HTTP request logging
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.'
});
// Rate limiting (disabled in development)
if (process.env.NODE_ENV !== 'development') {
  app.use('/api/', limiter);
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'api-gateway'
  });
});

// Swagger documentation
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SwiftTrack API',
      version: '1.0.0',
      description: 'SwiftTrack Logistics Platform API Documentation',
      contact: {
        name: 'SwiftTrack Support',
        email: 'support@swifttrack.com'
      }
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Development server'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    }
  },
  apis: ['./routes/*.js', '../services/*/routes/*.js']
};

const specs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Service discovery and health checking
const serviceRegistry = {
  'user-service': {
    url: process.env.USER_SERVICE_URL || 'http://localhost:3002',
    healthy: true,
    lastCheck: Date.now()
  },
  'order-service': {
    url: process.env.ORDER_SERVICE_URL || 'http://localhost:3003',
    healthy: true,
    lastCheck: Date.now()
  },
  'logistics-service': {
    url: process.env.LOGISTICS_SERVICE_URL || 'http://localhost:3004',
    healthy: true,
    lastCheck: Date.now()
  },
  'notification-service': {
    url: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005',
    healthy: true,
    lastCheck: Date.now()
  },
  'cms-adapter': {
    url: process.env.CMS_ADAPTER_URL || 'http://localhost:3006',
    healthy: true,
    lastCheck: Date.now()
  },
  'ros-adapter': {
    url: process.env.ROS_ADAPTER_URL || 'http://localhost:3007',
    healthy: true,
    lastCheck: Date.now()
  },
  'wms-adapter': {
    url: process.env.WMS_ADAPTER_URL || 'http://localhost:3008',
    healthy: true,
    lastCheck: Date.now()
  }
};

// Health check for services
const checkServiceHealth = async (serviceName, serviceUrl) => {
  try {
    const response = await fetch(`${serviceUrl}/health`);
    const healthy = response.ok;
    serviceRegistry[serviceName].healthy = healthy;
    serviceRegistry[serviceName].lastCheck = Date.now();
    return healthy;
  } catch (error) {
    logger.warn(`Service ${serviceName} health check failed:`, error.message);
    serviceRegistry[serviceName].healthy = false;
    serviceRegistry[serviceName].lastCheck = Date.now();
    return false;
  }
};

// Periodic health checks
setInterval(() => {
  Object.entries(serviceRegistry).forEach(([serviceName, service]) => {
    checkServiceHealth(serviceName, service.url);
  });
}, 30000); // Check every 30 seconds

// Route definitions with authentication and authorization

// Auth routes (public)
app.use('/api/auth', createProxyMiddleware({
  target: serviceRegistry['user-service'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/auth': '/api/auth'
  },
  onError: (err, req, res) => {
    logger.error('Auth service proxy error:', err);
    res.status(503).json({ error: 'Auth service unavailable' });
  }
}));

// User routes (authenticated)
app.use('/api/users', authenticateToken, createProxyMiddleware({
  target: serviceRegistry['user-service'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/users': '/api/users'
  },
  onProxyReq: (proxyReq, req, res) => {
    // Add user context to headers
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('User service proxy error:', err);
    res.status(503).json({ error: 'User service unavailable' });
  }
}));

// Order routes (authenticated)
app.use('/api/orders', authenticateToken, createProxyMiddleware({
  target: serviceRegistry['order-service'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/orders': '/api/orders'
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('Order service proxy error:', err);
    res.status(503).json({ error: 'Order service unavailable' });
  }
}));

// Driver routes (driver role only)
app.use('/api/drivers', authenticateToken, authorizeRole(['driver', 'admin']), createProxyMiddleware({
  target: serviceRegistry['logistics-service'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/drivers': '/api/drivers'
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('Logistics service proxy error:', err);
    res.status(503).json({ error: 'Logistics service unavailable' });
  }
}));

// Logistics routes (authenticated)
app.use('/api/logistics', authenticateToken, createProxyMiddleware({
  target: serviceRegistry['logistics-service'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/logistics': '/api/logistics'
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('Logistics service proxy error:', err);
    res.status(503).json({ error: 'Logistics service unavailable' });
  }
}));

// Notification WebSocket proxy
app.use('/socket.io', createProxyMiddleware({
  target: serviceRegistry['notification-service'].url,
  changeOrigin: true,
  ws: true,
  onError: (err, req, res) => {
    logger.error('Notification service proxy error:', err);
    res.status(503).json({ error: 'Notification service unavailable' });
  }
}));

// CMS Adapter routes (admin only)
app.use('/api/cms', authenticateToken, authorizeRole(['admin']), createProxyMiddleware({
  target: serviceRegistry['cms-adapter'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/cms': '/api/cms'
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('CMS adapter proxy error:', err);
    res.status(503).json({ error: 'CMS adapter unavailable' });
  }
}));

// ROS Adapter routes (internal service access only)
app.use('/api/ros', authenticateToken, authorizeRole(['admin', 'driver']), createProxyMiddleware({
  target: serviceRegistry['ros-adapter'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/ros': '/api/ros'
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('ROS adapter proxy error:', err);
    res.status(503).json({ error: 'ROS adapter unavailable' });
  }
}));

// WMS Adapter routes (admin only)
app.use('/api/wms', authenticateToken, authorizeRole(['admin']), createProxyMiddleware({
  target: serviceRegistry['wms-adapter'].url,
  changeOrigin: true,
  pathRewrite: {
    '^/api/wms': '/api/wms'
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-User-ID', req.user.id);
    proxyReq.setHeader('X-User-Role', req.user.role);
  },
  onError: (err, req, res) => {
    logger.error('WMS adapter proxy error:', err);
    res.status(503).json({ error: 'WMS adapter unavailable' });
  }
}));

// Service status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    gateway: {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    },
    services: serviceRegistry
  });
});

// Error handling
app.use(notFound);
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info(`API Documentation available at http://localhost:${PORT}/api-docs`);
});

module.exports = app;
