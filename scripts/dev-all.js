const concurrently = require('concurrently');
const logger = require('../shared/logger');

const services = [
  {
    name: 'api-gateway',
    command: 'pnpm run dev',
    cwd: './api-gateway',
    prefixColor: 'blue'
  },
  {
    name: 'user-service',
    command: 'pnpm run dev',
    cwd: './services/user-service',
    prefixColor: 'green'
  },
  {
    name: 'order-service',
    command: 'pnpm run dev',
    cwd: './services/order-service',
    prefixColor: 'yellow'
  },
  {
    name: 'logistics-service',
    command: 'pnpm run dev',
    cwd: './services/logistics-service',
    prefixColor: 'magenta'
  },
  {
    name: 'notification-service',
    command: 'pnpm run dev',
    cwd: './services/notification-service',
    prefixColor: 'cyan'
  },
  {
    name: 'cms-adapter',
    command: 'pnpm run dev',
    cwd: './services/cms-adapter',
    prefixColor: 'red'
  },
  {
    name: 'ros-adapter',
    command: 'pnpm run dev',
    cwd: './services/ros-adapter',
    prefixColor: 'white'
  },
  {
    name: 'wms-adapter',
    command: 'pnpm run dev',
    cwd: './services/wms-adapter',
    prefixColor: 'gray'
  }
];

// Graceful shutdown handling
function gracefulShutdown(signal, concurrentlyInstance = null) {
  logger.info(`\nReceived ${signal}. Gracefully shutting down all services...`);
  
  if (concurrentlyInstance) {
    concurrentlyInstance.commands.forEach(command => {
      if (command.pid) {
        logger.info(`Stopping ${command.name} (PID: ${command.pid})`);
        try {
          // On Windows, use taskkill; on Unix, use process.kill
          if (process.platform === 'win32') {
            require('child_process').exec(`taskkill /pid ${command.pid} /t /f`);
          } else {
            process.kill(command.pid, 'SIGTERM');
          }
        } catch (error) {
          logger.error(`Error stopping ${command.name}:`, error.message);
        }
      }
    });
  }
  
  setTimeout(() => {
    logger.info('All services stopped. Exiting...');
    process.exit(0);
  }, 2000);
}

logger.info('Starting all microservices in development mode...');
logger.info('Press Ctrl+C to stop all services\n');

const concurrentlyResult = concurrently(services, {
  prefix: 'name',
  killOthers: ['failure'],
  restartTries: 3,
  restartDelay: 2000,
  handleInput: true
});

// Handle Ctrl+C and other termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT', concurrentlyResult));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', concurrentlyResult));

// Handle Windows-specific signals
if (process.platform === 'win32') {
  require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  }).on('SIGINT', () => gracefulShutdown('SIGINT', concurrentlyResult));
}

concurrentlyResult.result.then(
  () => {
    logger.info('All services started successfully');
  },
  (error) => {
    logger.error('Failed to start services:', error);
    gracefulShutdown('ERROR', concurrentlyResult);
  }
);
