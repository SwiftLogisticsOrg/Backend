// index.js
// WMS Adapter: connects to WMS TCP mock and RabbitMQ
import net from 'net';
import amqp from 'amqplib';
import Debug from 'debug';

const debug = Debug('wms-adapter');
const info = Debug('wms-adapter:info');
info.log = console.log.bind(console);

//
// Configuration via env
//
const RABBIT_URL = process.env.RABBITMQ_URL || 'amqp://swifttrack:swifttrack123@localhost:5672';
const EXCHANGE = process.env.EXCHANGE || 'orders';
const WMS_HOST = process.env.WMS_HOST || '127.0.0.1';
const WMS_PORT = parseInt(process.env.WMS_PORT || '3008', 10);
const ADAPTER_ID = process.env.ADAPTER_ID || `wms-adp-${Math.random().toString(36).slice(2,8)}`;
const RECONNECT_RABBIT_MS = parseInt(process.env.RECONNECT_RABBIT_MS || '3000', 10);
const RECONNECT_WMS_MS = parseInt(process.env.WMS_RECONNECT_INTERVAL || '5000', 10);
const QUEUE_NAME = process.env.QUEUE_NAME || 'wms-adapter-q';

// in-memory map to correlate orderId -> packageId (populated when ack arrives)
const orderToPackage = new Map(); // orderId -> packageId

// RabbitMQ channel + connection holders
let amqpConn = null;
let amqpCh = null;

// TCP socket to WMS
let wmsSocket = null;
let wmsBuffer = '';

// helpers
function sendLineToWms(obj) {
  if (!wmsSocket || wmsSocket.destroyed) {
    debug('WMS socket not connected, cannot send:', obj);
    return false;
  }
  try {
    wmsSocket.write(JSON.stringify(obj) + '\n');
    debug('-> WMS', obj);
    return true;
  } catch (err) {
    console.error('Error writing to WMS socket:', err.message);
    return false;
  }
}

function publishRoutingKey(key, payload) {
  if (!amqpCh) {
    console.warn('AMQP channel not connected, cannot publish', key, payload);
    return;
  }
  try {
    amqpCh.publish(EXCHANGE, key, Buffer.from(JSON.stringify(payload)), { persistent: false });
    info(`[AMQP] published ${key}:`, payload);
  } catch (err) {
    console.error('AMQP publish error:', err.message);
  }
}

// map WMS event types to routing keys
const wmsTypeToRoutingKey = {
  ack: 'wms.package.ack',
  package_received: 'wms.package.received',
  package_ready: 'wms.package.ready',
  package_scanned: 'wms.package.scanned',
  package_loaded: 'wms.package.loaded',
  error: 'wms.package.error'
};

// handle WMS incoming JSON message (parsed)
function handleWmsMessage(msg) {
  debug('<- WMS', msg);
  const t = msg.type;
  if (!t) return;

  // common payload: include packageId and orderId if present
  const payload = {
    packageId: msg.packageId || null,
    orderId: msg.orderId || null,
    raw: msg,
    timestamp: new Date().toISOString()
  };

  // When ack arrives, map packageId => orderId
  if (t === 'ack') {
    // ack payload usually includes packageId and orderId
    if (msg.packageId && msg.orderId) {
      orderToPackage.set(msg.orderId, msg.packageId);
      payload.packageId = msg.packageId;
      payload.orderId = msg.orderId;
    }
    // publish ack event
    publishRoutingKey(wmsTypeToRoutingKey.ack, payload);
    return;
  }

  // For other events, try to fill missing orderId/packageId from correlation map
  if (!payload.orderId && payload.packageId) {
    // nothing to do; WMS provides packageId -> maybe orderId mapping exists
    // nothing extra
  }
  if (!payload.orderId && payload.packageId) {
    // try to find orderId by package
    for (const [orderId, pkgId] of orderToPackage.entries()) {
      if (pkgId === payload.packageId) {
        payload.orderId = orderId;
        break;
      }
    }
  }
  if (!payload.packageId && payload.orderId) {
    // try to fill packageId from map
    if (orderToPackage.has(payload.orderId)) {
      payload.packageId = orderToPackage.get(payload.orderId);
    }
  }

  // Publish mapped event if mapping exists
  const rk = wmsTypeToRoutingKey[t] || `wms.package.${t}`;
  publishRoutingKey(rk, payload);
}

// connect to WMS TCP server (with reconnect)
function connectWms() {
  debug(`Connecting to WMS ${WMS_HOST}:${WMS_PORT} ...`);
  wmsSocket = net.createConnection({ host: WMS_HOST, port: WMS_PORT }, () => {
    info(`[WMS] connected to ${WMS_HOST}:${WMS_PORT}`);
    // register adapter
    const reg = { type: 'register_adapter', adapterId: ADAPTER_ID, capabilities: ['receive', 'scan', 'load'] };
    sendLineToWms(reg);
  });

  wmsSocket.setEncoding('utf8');

  wmsSocket.on('data', (chunk) => {
    wmsBuffer += chunk;
    let idx;
    while ((idx = wmsBuffer.indexOf('\n')) >= 0) {
      const line = wmsBuffer.slice(0, idx).trim();
      wmsBuffer = wmsBuffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        handleWmsMessage(msg);
      } catch (err) {
        console.warn('Failed parse WMS line:', err.message, 'line:', line);
      }
    }
  });

  wmsSocket.on('close', () => {
    console.warn('[WMS] socket closed; reconnecting in', RECONNECT_WMS_MS, 'ms');
    setTimeout(connectWms, RECONNECT_WMS_MS);
  });

  wmsSocket.on('error', (err) => {
    console.error('[WMS] socket error:', err.message);
    wmsSocket.destroy();
  });
}

// connect to RabbitMQ and setup consumer
async function connectRabbit() {
  try {
    info('[AMQP] connecting to', RABBIT_URL);
    amqpConn = await amqp.connect(RABBIT_URL);
    amqpCh = await amqpConn.createChannel();
    await amqpCh.assertExchange(EXCHANGE, 'topic', { durable: false });

    // create/load queue and bind to order.created
    await amqpCh.assertQueue(QUEUE_NAME, { durable: false });
    await amqpCh.bindQueue(QUEUE_NAME, EXCHANGE, 'order.created');

    info('[AMQP] waiting for messages on queue:', QUEUE_NAME);
    amqpCh.consume(QUEUE_NAME, async (msg) => {
      if (!msg) return;
      try {
        const content = JSON.parse(msg.content.toString());
        info('[AMQP] Received order.created:', content);

        // Validate minimal: orderId required
        if (!content.orderId) {
          console.warn('[AMQP] order.created missing orderId; acking and skipping');
          amqpCh.ack(msg);
          return;
        }

        // Build receive_package command to WMS
        const command = {
          type: 'receive_package',
          orderId: content.orderId,
          clientOrderRef: content.orderId,
          items: content.items || [],
          pickup: content.pickup || null,
          delivery: content.delivery || null,
          contact: content.contact || null,
          callbackMeta: { correlationId: content.correlationId || null }
        };

        // Try to send to WMS; if not connected, nack (requeue) so that it can be retried later
        const ok = sendLineToWms(command);
        if (!ok) {
          console.warn('[AMQP] WMS not connected — NACK and requeue message for later');
          amqpCh.nack(msg, false, true); // requeue
          return;
        }

        // If sent, ack the message to remove from queue
        amqpCh.ack(msg);
      } catch (err) {
        console.error('[AMQP] Failed to process message:', err.message);
        // ack to avoid poison; in production you might DLQ
        amqpCh.ack(msg);
      }
    }, { noAck: false });

    amqpConn.on('error', (err) => {
      console.error('[AMQP] connection error:', err.message);
    });
    amqpConn.on('close', () => {
      console.warn('[AMQP] connection closed; reconnecting in', RECONNECT_RABBIT_MS, 'ms');
      amqpCh = null;
      amqpConn = null;
      setTimeout(connectRabbit, RECONNECT_RABBIT_MS);
    });
  } catch (err) {
    console.error('[AMQP] startup error:', err.message);
    setTimeout(connectRabbit, RECONNECT_RABBIT_MS);
  }
}

// start everything
(async function main() {
  // Connect WMS first
  connectWms();
  // Connect Rabbit
  await connectRabbit();

  // simple heartbeat log
  setInterval(() => {
    info(`[STATUS] adapter=${ADAPTER_ID} wms=${(wmsSocket && !wmsSocket.destroyed) ? 'connected' : 'disconnected'} amqp=${amqpConn ? 'connected' : 'disconnected'} trackedOrders=${orderToPackage.size}`);
  }, 15000);
})();
