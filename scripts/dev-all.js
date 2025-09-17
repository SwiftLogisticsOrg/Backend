const concurrently = require('concurrently');
const logger = require('../shared/logger');

const services = [
  {
    name: 'api-gateway',
    command: 'npm run dev',
    cwd: './api-gateway',
    prefixColor: 'blue'
  },
  {
    name: 'user-service',
    command: 'npm run dev',
    cwd: './services/user-service',
    prefixColor: 'green'
  },
  {
    name: 'order-service',
    command: 'npm run dev',
    cwd: './services/order-service',
    prefixColor: 'yellow'
  },
  {
    name: 'logistics-service',
    command: 'npm run dev',
    cwd: './services/logistics-service',
    prefixColor: 'magenta'
  },
  {
    name: 'notification-service',
    command: 'npm run dev',
    cwd: './services/notification-service',
    prefixColor: 'cyan'
  }
];

logger.info('Starting all services in development mode...');

concurrently(services, {
  prefix: 'name',
  killOthers: ['failure', 'success'],
  restartTries: 3,
  restartDelay: 2000
}).then(
  () => {
    logger.info('All services started successfully');
  },
  (error) => {
    logger.error('Failed to start services:', error);
    process.exit(1);
  }
);
