require('dotenv').config();
const express = require('express');
const soap = require('soap');
const xml2js = require('xml2js');

const logger = require('../../shared/logger');
const { asyncHandler, errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');

const app = express();
const PORT = process.env.PORT || 3006;

// SOAP client
let soapClient = null;

// Initialize SOAP client
async function initializeSoapClient() {
  try {
    if (process.env.CMS_SOAP_URL) {
      soapClient = await soap.createClientAsync(process.env.CMS_SOAP_URL, {
        timeout: parseInt(process.env.CMS_TIMEOUT) || 30000
      });
      logger.info('CMS SOAP client initialized');
    } else {
      logger.warn('CMS_SOAP_URL not configured - running in mock mode');
    }
  } catch (error) {
    logger.error('Failed to initialize CMS SOAP client:', error);
    // Continue without SOAP client - will use mock responses
  }
}

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'cms-adapter',
    externalConnection: soapClient ? 'connected' : 'disconnected'
  });
});

// CMS Adapter Functions
const CMSAdapter = {
  // Transform internal customer data to CMS format
  transformCustomerToCMS(customer) {
    return {
      CustomerID: customer.id,
      CustomerName: customer.name,
      Email: customer.email,
      Phone: customer.phone,
      Status: customer.active ? 'ACTIVE' : 'INACTIVE',
      CreatedDate: customer.createdAt,
      CustomerType: customer.role === 'client' ? 'INDIVIDUAL' : 'BUSINESS'
    };
  },

  // Transform CMS customer data to internal format
  transformCustomerFromCMS(cmsCustomer) {
    return {
      id: cmsCustomer.CustomerID,
      name: cmsCustomer.CustomerName,
      email: cmsCustomer.Email,
      phone: cmsCustomer.Phone,
      active: cmsCustomer.Status === 'ACTIVE',
      createdAt: cmsCustomer.CreatedDate,
      role: cmsCustomer.CustomerType === 'INDIVIDUAL' ? 'client' : 'business',
      source: 'cms'
    };
  },

  // Create customer in CMS
  async createCustomer(customerData) {
    if (!soapClient) {
      // Mock response when CMS is not available
      logger.info('CMS not available, returning mock response for customer creation');
      return {
        success: true,
        customerId: `cms-${Date.now()}`,
        message: 'Customer created in mock CMS'
      };
    }

    try {
      const cmsCustomer = this.transformCustomerToCMS(customerData);
      
      const args = {
        customer: cmsCustomer,
        authentication: {
          username: process.env.CMS_USERNAME,
          password: process.env.CMS_PASSWORD
        }
      };

      const result = await soapClient.CreateCustomerAsync(args);
      
      return {
        success: result[0].Success,
        customerId: result[0].CustomerID,
        message: result[0].Message
      };
    } catch (error) {
      logger.error('CMS createCustomer error:', error);
      throw new Error(`CMS customer creation failed: ${error.message}`);
    }
  },

  // Update customer in CMS
  async updateCustomer(customerId, customerData) {
    if (!soapClient) {
      logger.info('CMS not available, returning mock response for customer update');
      return {
        success: true,
        customerId,
        message: 'Customer updated in mock CMS'
      };
    }

    try {
      const cmsCustomer = this.transformCustomerToCMS(customerData);
      cmsCustomer.CustomerID = customerId;
      
      const args = {
        customer: cmsCustomer,
        authentication: {
          username: process.env.CMS_USERNAME,
          password: process.env.CMS_PASSWORD
        }
      };

      const result = await soapClient.UpdateCustomerAsync(args);
      
      return {
        success: result[0].Success,
        customerId: result[0].CustomerID,
        message: result[0].Message
      };
    } catch (error) {
      logger.error('CMS updateCustomer error:', error);
      throw new Error(`CMS customer update failed: ${error.message}`);
    }
  },

  // Get customer from CMS
  async getCustomer(customerId) {
    if (!soapClient) {
      logger.info('CMS not available, returning mock customer data');
      return {
        id: customerId,
        name: 'Mock Customer',
        email: 'mock@cms.com',
        phone: '+1234567890',
        active: true,
        createdAt: new Date().toISOString(),
        role: 'client',
        source: 'cms-mock'
      };
    }

    try {
      const args = {
        customerId: customerId,
        authentication: {
          username: process.env.CMS_USERNAME,
          password: process.env.CMS_PASSWORD
        }
      };

      const result = await soapClient.GetCustomerAsync(args);
      
      if (result[0].Success) {
        return this.transformCustomerFromCMS(result[0].Customer);
      } else {
        return null;
      }
    } catch (error) {
      logger.error('CMS getCustomer error:', error);
      throw new Error(`CMS customer retrieval failed: ${error.message}`);
    }
  },

  // Sync customer status
  async syncCustomerStatus(customerId, status) {
    if (!soapClient) {
      logger.info('CMS not available, mock sync response');
      return { success: true, message: 'Status synced with mock CMS' };
    }

    try {
      const args = {
        customerId: customerId,
        status: status ? 'ACTIVE' : 'INACTIVE',
        authentication: {
          username: process.env.CMS_USERNAME,
          password: process.env.CMS_PASSWORD
        }
      };

      const result = await soapClient.UpdateCustomerStatusAsync(args);
      
      return {
        success: result[0].Success,
        message: result[0].Message
      };
    } catch (error) {
      logger.error('CMS syncCustomerStatus error:', error);
      throw new Error(`CMS status sync failed: ${error.message}`);
    }
  }
};

// Routes

/**
 * @swagger
 * /api/cms/customers:
 *   post:
 *     summary: Create customer in CMS
 *     tags: [CMS Adapter]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               phone:
 *                 type: string
 *               role:
 *                 type: string
 *     responses:
 *       201:
 *         description: Customer created in CMS
 *       500:
 *         description: CMS integration error
 */
app.post('/api/cms/customers', asyncHandler(async (req, res) => {
  const customerData = req.body;
  
  const result = await CMSAdapter.createCustomer(customerData);
  
  // Publish CMS sync event
  await messageBroker.publish(
    messageBroker.exchanges.USERS,
    'cms.customer.created',
    {
      customerId: result.customerId,
      originalId: customerData.id,
      success: result.success,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Customer created in CMS:', { customerId: result.customerId });

  res.status(201).json({
    success: true,
    data: result
  });
}));

/**
 * @swagger
 * /api/cms/customers/{id}:
 *   put:
 *     summary: Update customer in CMS
 *     tags: [CMS Adapter]
 *     security:
 *       - bearerAuth: []
 */
app.put('/api/cms/customers/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const customerData = req.body;
  
  const result = await CMSAdapter.updateCustomer(id, customerData);
  
  // Publish CMS sync event
  await messageBroker.publish(
    messageBroker.exchanges.USERS,
    'cms.customer.updated',
    {
      customerId: id,
      success: result.success,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Customer updated in CMS:', { customerId: id });

  res.json({
    success: true,
    data: result
  });
}));

/**
 * @swagger
 * /api/cms/customers/{id}:
 *   get:
 *     summary: Get customer from CMS
 *     tags: [CMS Adapter]
 *     security:
 *       - bearerAuth: []
 */
app.get('/api/cms/customers/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const customer = await CMSAdapter.getCustomer(id);
  
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found in CMS' });
  }

  res.json({
    success: true,
    data: customer
  });
}));

/**
 * @swagger
 * /api/cms/customers/{id}/status:
 *   patch:
 *     summary: Sync customer status with CMS
 *     tags: [CMS Adapter]
 *     security:
 *       - bearerAuth: []
 */
app.patch('/api/cms/customers/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  
  const result = await CMSAdapter.syncCustomerStatus(id, active);
  
  // Publish CMS sync event
  await messageBroker.publish(
    messageBroker.exchanges.USERS,
    'cms.customer.status.updated',
    {
      customerId: id,
      status: active,
      success: result.success,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Customer status synced with CMS:', { customerId: id, active });

  res.json({
    success: true,
    data: result
  });
}));

// Message broker event handlers
async function setupEventHandlers() {
  // Handle user created events to sync with CMS
  await messageBroker.subscribe(
    messageBroker.queues.USER_CREATED,
    async (data) => {
      logger.info('User created event received, syncing with CMS:', data);
      
      try {
        await CMSAdapter.createCustomer({
          id: data.userId,
          name: data.name || 'Unknown',
          email: data.email,
          phone: data.phone,
          role: data.role,
          active: true,
          createdAt: data.timestamp
        });
      } catch (error) {
        logger.error('Failed to sync user creation with CMS:', error);
      }
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

// Initialize and start server
async function startServer() {
  try {
    await initializeSoapClient();
    await messageBroker.connect();
    await setupEventHandlers();
    
    app.listen(PORT, () => {
      logger.info(`CMS Adapter running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start CMS Adapter:', error);
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
