const concurrently = require('concurrently');
const logger = require('../shared/logger');

const services = [
  {
    name: 'api-gateway',
    command: 'npm start',
    cwd: './api-gateway',
    prefixColor: 'blue'
  },
  {
    name: 'user-service',
    command: 'npm start',
    cwd: './services/user-service',
    prefixColor: 'green'
  },
  {
    name: 'order-service',
    command: 'npm start',
    cwd: './services/order-service',
    prefixColor: 'yellow'
  },
  {
    name: 'logistics-service',
    command: 'npm start',
    cwd: './services/logistics-service',
    prefixColor: 'magenta'
  },
  {
    name: 'notification-service',
    command: 'npm start',
    cwd: './services/notification-service',
    prefixColor: 'cyan'
  }
];

logger.info('Starting all services in production mode...');

concurrently(services, {
  prefix: 'name',
  killOthers: ['failure'],
  restartTries: 5,
  restartDelay: 3000
}).then(
  () => {
    logger.info('All services started successfully');
  },
  (error) => {
    logger.error('Failed to start services:', error);
    process.exit(1);
  }
);
