import amqp from 'amqplib';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { v4 as uuidv4 } from 'uuid';

import dotenv from 'dotenv';
dotenv.config();

// Config (env vars or defaults)
const RABBIT_URL = process.env.RABBITMQ_URL || 'amqp://swifttrack:swifttrack123@localhost:5672';
const CMS_URL = process.env.CMS_URL || 'http://localhost:3006/soap';
const EXCHANGE = process.env.EXCHANGE || 'orders';

// Helper: build CreateOrder SOAP envelope
function buildCreateOrderSOAP(order) {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
      <CreateOrderRequest xmlns="http://swiftlogistics.cms/">
        <ClientId>${order.clientId || 'unknown'}</ClientId>
        <ClientOrderRef>${order.orderId}</ClientOrderRef>
        <PickupAddress>${order.pickup || ''}</PickupAddress>
        <DeliveryAddress>${order.delivery || ''}</DeliveryAddress>
        <Items>
          ${(order.items || [])
            .map(
              (it) => `<Item><Name>${it.name}</Name><Qty>${it.qty}</Qty></Item>`
            )
            .join('')}
        </Items>
        <Contact>${order.contact || ''}</Contact>
      </CreateOrderRequest>
    </soap:Body>
  </soap:Envelope>`;
}

// Helper: call CMS SOAP endpoint
async function callCMSCreateOrder(order) {
  const soapBody = buildCreateOrderSOAP(order);
  try {
    const { data } = await axios.post(CMS_URL, soapBody, {
      headers: {
        'Content-Type': 'text/xml',
        SOAPAction: 'CreateOrder'
      },
      timeout: 5000
    });

    // Parse XML response
    const parsed = await parseStringPromise(data, { explicitArray: false });
    const resp =
      parsed['soap:Envelope']?.['soap:Body']?.['CreateOrderResponse'] ||
      parsed.Envelope?.Body?.CreateOrderResponse;

    if (!resp) throw new Error('Invalid SOAP response');

    return {
      success: resp.Success === 'true' || resp.Success === true,
      cmsOrderId: resp.CmsOrderId,
      billingRef: resp.BillingRef,
      message: resp.Message
    };
  } catch (err) {
    console.error('[CMS Adapter] SOAP error:', err.message);
    throw err;
  }
}

// Main function
async function start() {
  console.log('[CMS Adapter] Connecting to RabbitMQ at', RABBIT_URL);
  const conn = await amqp.connect(RABBIT_URL);
  const ch = await conn.createChannel();

  await ch.assertExchange(EXCHANGE, 'topic', { durable: false });

  // Queue to consume order.created events
  const q = await ch.assertQueue('cms-adapter-q', { durable: false });
  await ch.bindQueue(q.queue, EXCHANGE, 'order.created');

  console.log('[CMS Adapter] Waiting for order.created events...');

  ch.consume(
    q.queue,
    async (msg) => {
      if (!msg) return;
      try {
        const content = JSON.parse(msg.content.toString());
        console.log('[CMS Adapter] Received order.created:', content);

        // Call CMS SOAP endpoint
        const cmsResp = await callCMSCreateOrder(content);

        if (cmsResp.success) {
          const eventPayload = {
            cmsOrderId: cmsResp.cmsOrderId,
            billingRef: cmsResp.billingRef,
            localOrderId: content.orderId,
            clientId: content.clientId,
            status: 'cms_created',
            message: cmsResp.message,
            correlationId: uuidv4()
          };

          // Publish cms.order.created
          ch.publish(
            EXCHANGE,
            'cms.order.created',
            Buffer.from(JSON.stringify(eventPayload)),
            { persistent: false }
          );
          console.log('[CMS Adapter] Published cms.order.created:', eventPayload);
        }
      } catch (err) {
        console.error('[CMS Adapter] Failed processing order:', err.message);
      } finally {
        ch.ack(msg);
      }
    },
    { noAck: false }
  );
}

start().catch((err) => {
  console.error('CMS Adapter startup error:', err);
  process.exit(1);
});
