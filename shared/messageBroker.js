const amqp = require('amqplib');
const logger = require('./logger');

class MessageBroker {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.exchanges = {
      ORDERS: 'orders.exchange',
      USERS: 'users.exchange',
      LOGISTICS: 'logistics.exchange',
      NOTIFICATIONS: 'notifications.exchange'
    };
    this.queues = {
      ORDER_CREATED: 'order.created',
      ORDER_UPDATED: 'order.updated',
      USER_CREATED: 'user.created',
      DRIVER_ASSIGNED: 'driver.assigned',
      NOTIFICATION_SEND: 'notification.send',
      LOGISTICS_UPDATE: 'logistics.update'
    };
  }

  async connect() {
    try {
      const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://swifttrack:swifttrack123@localhost:5672';
      this.connection = await amqp.connect(rabbitmqUrl);
      this.channel = await this.connection.createChannel();

      // Setup exchanges
      await Promise.all(
        Object.values(this.exchanges).map(exchange =>
          this.channel.assertExchange(exchange, 'topic', { durable: true })
        )
      );

      // Setup queues
      await Promise.all(
        Object.values(this.queues).map(queue =>
          this.channel.assertQueue(queue, { durable: true })
        )
      );

      logger.info('Message broker connected successfully');
      
      // Handle connection errors
      this.connection.on('error', (err) => {
        logger.error('RabbitMQ connection error:', err);
      });

      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed');
      });

    } catch (error) {
      logger.error('Failed to connect to message broker:', error);
      throw error;
    }
  }

  async publish(exchange, routingKey, message, options = {}) {
    if (!this.channel) {
      throw new Error('Message broker not connected');
    }

    try {
      const messageBuffer = Buffer.from(JSON.stringify(message));
      await this.channel.publish(exchange, routingKey, messageBuffer, {
        persistent: true,
        timestamp: Date.now(),
        ...options
      });
      
      logger.debug('Message published', { exchange, routingKey, message });
    } catch (error) {
      logger.error('Failed to publish message:', error);
      throw error;
    }
  }

  async subscribe(queue, callback, options = {}) {
    if (!this.channel) {
      throw new Error('Message broker not connected');
    }

    try {
      // Assert queue exists before consuming
      await this.channel.assertQueue(queue, { durable: true });
      
      await this.channel.consume(queue, async (msg) => {
        if (msg) {
          try {
            const content = JSON.parse(msg.content.toString());
            await callback(content, msg);
            this.channel.ack(msg);
          } catch (error) {
            logger.error('Error processing message:', error);
            this.channel.nack(msg, false, false); // Don't requeue failed messages
          }
        }
      }, {
        noAck: false,
        ...options
      });

      logger.info(`Subscribed to queue: ${queue}`);
    } catch (error) {
      logger.error('Failed to subscribe to queue:', error);
      throw error;
    }
  }

  async bindQueue(queue, exchange, routingKey) {
    if (!this.channel) {
      throw new Error('Message broker not connected');
    }

    try {
      await this.channel.bindQueue(queue, exchange, routingKey);
      logger.debug(`Queue ${queue} bound to ${exchange} with routing key ${routingKey}`);
    } catch (error) {
      logger.error('Failed to bind queue:', error);
      throw error;
    }
  }

  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
      logger.info('Message broker connection closed');
    } catch (error) {
      logger.error('Error closing message broker connection:', error);
    }
  }
}

module.exports = new MessageBroker();
