require('dotenv').config();
const express = require('express');
const net = require('net');

const logger = require('../../shared/logger');
const { asyncHandler, errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');

const app = express();
const PORT = process.env.PORT || 3008;

// TCP connection to WMS
let wmsConnection = null;
let isConnected = false;
let reconnectTimer = null;

// WMS Protocol Constants
const WMS_COMMANDS = {
  INVENTORY_CHECK: 'INV_CHK',
  RESERVE_STOCK: 'RES_STK',
  RELEASE_STOCK: 'REL_STK',
  UPDATE_STOCK: 'UPD_STK',
  CREATE_SHIPMENT: 'CRT_SHP',
  UPDATE_SHIPMENT: 'UPD_SHP',
  PING: 'PING'
};

const WMS_RESPONSES = {
  SUCCESS: 'OK',
  ERROR: 'ERR',
  NOT_FOUND: 'NF',
  INSUFFICIENT_STOCK: 'IS'
};

// Initialize TCP connection to WMS
function initializeWMSConnection() {
  if (!process.env.WMS_HOST || !process.env.WMS_PORT) {
    logger.warn('WMS connection not configured - running in mock mode');
    return;
  }

  wmsConnection = new net.Socket();
  
  wmsConnection.connect(parseInt(process.env.WMS_PORT), process.env.WMS_HOST, () => {
    logger.info('Connected to WMS via TCP');
    isConnected = true;
    
    // Send ping to verify connection
    sendWMSCommand(WMS_COMMANDS.PING, {});
  });

  wmsConnection.on('data', (data) => {
    handleWMSResponse(data.toString());
  });

  wmsConnection.on('error', (error) => {
    logger.error('WMS connection error:', error);
    isConnected = false;
    scheduleReconnect();
  });

  wmsConnection.on('close', () => {
    logger.warn('WMS connection closed');
    isConnected = false;
    scheduleReconnect();
  });

  wmsConnection.setTimeout(parseInt(process.env.WMS_TIMEOUT) || 30000, () => {
    logger.error('WMS connection timeout');
    wmsConnection.destroy();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  
  const interval = parseInt(process.env.WMS_RECONNECT_INTERVAL) || 5000;
  reconnectTimer = setTimeout(() => {
    logger.info('Attempting to reconnect to WMS...');
    reconnectTimer = null;
    initializeWMSConnection();
  }, interval);
}

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'wms-adapter',
    externalConnection: isConnected ? 'connected' : 'disconnected'
  });
});

// WMS Communication Functions
const pendingRequests = new Map();
let requestCounter = 0;

function sendWMSCommand(command, data, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!isConnected) {
      return reject(new Error('WMS not connected'));
    }

    const requestId = ++requestCounter;
    const message = formatWMSMessage(requestId, command, data);
    
    // Store request for response correlation
    pendingRequests.set(requestId, { resolve, reject, command });
    
    // Set timeout
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('WMS request timeout'));
      }
    }, timeout);

    try {
      wmsConnection.write(message);
      logger.debug('Sent WMS command:', { requestId, command });
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error);
    }
  });
}

function formatWMSMessage(requestId, command, data) {
  // WMS protocol: [REQUEST_ID]|[COMMAND]|[DATA_JSON]\n
  const message = `${requestId}|${command}|${JSON.stringify(data)}\n`;
  return message;
}

function handleWMSResponse(rawData) {
  const lines = rawData.trim().split('\n');
  
  lines.forEach(line => {
    try {
      const [requestId, status, responseData] = line.split('|', 3);
      const numericRequestId = parseInt(requestId);
      
      if (pendingRequests.has(numericRequestId)) {
        const { resolve, reject, command } = pendingRequests.get(numericRequestId);
        pendingRequests.delete(numericRequestId);
        
        if (status === WMS_RESPONSES.SUCCESS) {
          resolve({
            success: true,
            data: responseData ? JSON.parse(responseData) : {},
            command
          });
        } else {
          reject(new Error(`WMS error: ${status} - ${responseData}`));
        }
      }
    } catch (error) {
      logger.error('Error parsing WMS response:', error);
    }
  });
}

// WMS Adapter Functions
const WMSAdapter = {
  // Check inventory availability
  async checkInventory(items) {
    if (!isConnected) {
      logger.warn('WMS not connected, returning mock inventory data');
      return {
        available: true,
        items: items.map(item => ({
          ...item,
          availableQuantity: item.quantity + 10,
          location: 'MOCK-LOC-001'
        }))
      };
    }

    try {
      const result = await sendWMSCommand(WMS_COMMANDS.INVENTORY_CHECK, { items });
      return result.data;
    } catch (error) {
      logger.error('WMS inventory check failed:', error);
      throw new Error(`Inventory check failed: ${error.message}`);
    }
  },

  // Reserve stock for order
  async reserveStock(orderId, items) {
    if (!isConnected) {
      logger.warn('WMS not connected, returning mock reservation');
      return {
        reservationId: `MOCK-RES-${Date.now()}`,
        reserved: true,
        items: items.map(item => ({ ...item, reserved: true }))
      };
    }

    try {
      const result = await sendWMSCommand(WMS_COMMANDS.RESERVE_STOCK, {
        orderId,
        items
      });
      return result.data;
    } catch (error) {
      logger.error('WMS stock reservation failed:', error);
      throw new Error(`Stock reservation failed: ${error.message}`);
    }
  },

  // Release reserved stock
  async releaseStock(reservationId) {
    if (!isConnected) {
      logger.warn('WMS not connected, returning mock release confirmation');
      return { released: true, reservationId };
    }

    try {
      const result = await sendWMSCommand(WMS_COMMANDS.RELEASE_STOCK, {
        reservationId
      });
      return result.data;
    } catch (error) {
      logger.error('WMS stock release failed:', error);
      throw new Error(`Stock release failed: ${error.message}`);
    }
  },

  // Create shipment in WMS
  async createShipment(shipmentData) {
    if (!isConnected) {
      logger.warn('WMS not connected, returning mock shipment');
      return {
        shipmentId: `MOCK-SHP-${Date.now()}`,
        status: 'CREATED',
        trackingNumber: `TRK${Date.now()}`
      };
    }

    try {
      const wmsShipment = {
        orderId: shipmentData.orderId,
        items: shipmentData.items,
        destination: shipmentData.deliveryAddress,
        priority: shipmentData.priority || 'STANDARD',
        specialInstructions: shipmentData.notes
      };

      const result = await sendWMSCommand(WMS_COMMANDS.CREATE_SHIPMENT, wmsShipment);
      return result.data;
    } catch (error) {
      logger.error('WMS shipment creation failed:', error);
      throw new Error(`Shipment creation failed: ${error.message}`);
    }
  },

  // Update shipment status
  async updateShipmentStatus(shipmentId, status, metadata = {}) {
    if (!isConnected) {
      logger.warn('WMS not connected, returning mock update confirmation');
      return { updated: true, shipmentId, status };
    }

    try {
      const result = await sendWMSCommand(WMS_COMMANDS.UPDATE_SHIPMENT, {
        shipmentId,
        status,
        metadata
      });
      return result.data;
    } catch (error) {
      logger.error('WMS shipment update failed:', error);
      throw new Error(`Shipment update failed: ${error.message}`);
    }
  },

  // Update stock levels
  async updateStock(stockUpdates) {
    if (!isConnected) {
      logger.warn('WMS not connected, returning mock stock update');
      return { updated: true, items: stockUpdates };
    }

    try {
      const result = await sendWMSCommand(WMS_COMMANDS.UPDATE_STOCK, {
        updates: stockUpdates
      });
      return result.data;
    } catch (error) {
      logger.error('WMS stock update failed:', error);
      throw new Error(`Stock update failed: ${error.message}`);
    }
  }
};

// Routes

/**
 * @swagger
 * /api/wms/inventory/check:
 *   post:
 *     summary: Check inventory availability in WMS
 *     tags: [WMS Adapter]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     sku:
 *                       type: string
 *                     quantity:
 *                       type: number
 *     responses:
 *       200:
 *         description: Inventory check completed
 *       500:
 *         description: WMS integration error
 */
app.post('/api/wms/inventory/check', asyncHandler(async (req, res) => {
  const { items } = req.body;
  
  const inventory = await WMSAdapter.checkInventory(items);
  
  logger.info('Inventory check completed:', { itemCount: items.length });

  res.json({
    success: true,
    data: inventory
  });
}));

/**
 * @swagger
 * /api/wms/stock/reserve:
 *   post:
 *     summary: Reserve stock in WMS
 *     tags: [WMS Adapter]
 */
app.post('/api/wms/stock/reserve', asyncHandler(async (req, res) => {
  const { orderId, items } = req.body;
  
  const reservation = await WMSAdapter.reserveStock(orderId, items);
  
  // Publish stock reservation event
  await messageBroker.publish(
    messageBroker.exchanges.LOGISTICS,
    'wms.stock.reserved',
    {
      orderId,
      reservationId: reservation.reservationId,
      items,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Stock reserved:', { orderId, reservationId: reservation.reservationId });

  res.json({
    success: true,
    data: reservation
  });
}));

/**
 * @swagger
 * /api/wms/stock/release:
 *   post:
 *     summary: Release reserved stock in WMS
 *     tags: [WMS Adapter]
 */
app.post('/api/wms/stock/release', asyncHandler(async (req, res) => {
  const { reservationId } = req.body;
  
  const result = await WMSAdapter.releaseStock(reservationId);
  
  // Publish stock release event
  await messageBroker.publish(
    messageBroker.exchanges.LOGISTICS,
    'wms.stock.released',
    {
      reservationId,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Stock released:', { reservationId });

  res.json({
    success: true,
    data: result
  });
}));

/**
 * @swagger
 * /api/wms/shipments:
 *   post:
 *     summary: Create shipment in WMS
 *     tags: [WMS Adapter]
 */
app.post('/api/wms/shipments', asyncHandler(async (req, res) => {
  const shipmentData = req.body;
  
  const shipment = await WMSAdapter.createShipment(shipmentData);
  
  // Publish shipment creation event
  await messageBroker.publish(
    messageBroker.exchanges.LOGISTICS,
    'wms.shipment.created',
    {
      orderId: shipmentData.orderId,
      shipmentId: shipment.shipmentId,
      trackingNumber: shipment.trackingNumber,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Shipment created in WMS:', { 
    orderId: shipmentData.orderId, 
    shipmentId: shipment.shipmentId 
  });

  res.status(201).json({
    success: true,
    data: shipment
  });
}));

/**
 * @swagger
 * /api/wms/shipments/{id}/status:
 *   patch:
 *     summary: Update shipment status in WMS
 *     tags: [WMS Adapter]
 */
app.patch('/api/wms/shipments/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, metadata } = req.body;
  
  const result = await WMSAdapter.updateShipmentStatus(id, status, metadata);
  
  // Publish shipment status update event
  await messageBroker.publish(
    messageBroker.exchanges.LOGISTICS,
    'wms.shipment.status.updated',
    {
      shipmentId: id,
      status,
      metadata,
      timestamp: new Date().toISOString()
    }
  );

  logger.info('Shipment status updated:', { shipmentId: id, status });

  res.json({
    success: true,
    data: result
  });
}));

// Message broker event handlers
async function setupEventHandlers() {
  // Handle order created events to create shipments
  await messageBroker.subscribe(
    messageBroker.queues.ORDER_CREATED,
    async (data) => {
      logger.info('Order created event received, creating WMS shipment:', data);
      
      try {
        // Auto-create shipment in WMS for new orders
        await WMSAdapter.createShipment({
          orderId: data.orderId,
          items: data.items || [],
          deliveryAddress: data.deliveryAddress,
          priority: data.priority,
          notes: data.notes
        });
      } catch (error) {
        logger.error('Failed to create WMS shipment for order:', error);
      }
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
    initializeWMSConnection();
    await messageBroker.connect();
    await setupEventHandlers();
    
    app.listen(PORT, () => {
      logger.info(`WMS Adapter running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start WMS Adapter:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  if (wmsConnection) {
    wmsConnection.destroy();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  await messageBroker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  if (wmsConnection) {
    wmsConnection.destroy();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  await messageBroker.close();
  process.exit(0);
});

startServer();

module.exports = app;
