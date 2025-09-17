const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../shared/logger');

async function setup() {
  try {
    logger.info('Setting up SwiftTrack Backend...');

    // Create logs directory
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      logger.info('Created logs directory');
    }

    // Copy environment files
    const services = [
      'api-gateway',
      'services/user-service',
      'services/order-service',
      'services/logistics-service',
      'services/notification-service'
    ];

    for (const service of services) {
      const envExamplePath = path.join(__dirname, '..', service, '.env.example');
      const envPath = path.join(__dirname, '..', service, '.env');
      
      if (fs.existsSync(envExamplePath) && !fs.existsSync(envPath)) {
        fs.copyFileSync(envExamplePath, envPath);
        logger.info(`Created .env file for ${service}`);
      }
    }

    // Install dependencies for all services
    logger.info('Installing dependencies...');
    
    const rootPackageJson = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(rootPackageJson)) {
      execSync('npm install', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    }

    for (const service of services) {
      const servicePath = path.join(__dirname, '..', service);
      const packageJsonPath = path.join(servicePath, 'package.json');
      
      if (fs.existsSync(packageJsonPath)) {
        logger.info(`Installing dependencies for ${service}...`);
        execSync('npm install', { cwd: servicePath, stdio: 'inherit' });
      }
    }

    // Create Docker initialization files
    await createDockerFiles();

    logger.info('Setup completed successfully!');
    logger.info('');
    logger.info('Next steps:');
    logger.info('1. Start infrastructure: npm run docker:up');
    logger.info('2. Run migrations: npm run migrate');
    logger.info('3. Start services: npm run dev');
    logger.info('');
    logger.info('API Gateway will be available at: http://localhost:3001');
    logger.info('API Documentation: http://localhost:3001/api-docs');

  } catch (error) {
    logger.error('Setup failed:', error);
    process.exit(1);
  }
}

async function createDockerFiles() {
  // Create Docker initialization files
  const dockerDir = path.join(__dirname, '..', 'docker');
  
  // PostgreSQL init script
  const postgresDir = path.join(dockerDir, 'postgres');
  if (!fs.existsSync(postgresDir)) {
    fs.mkdirSync(postgresDir, { recursive: true });
  }
  
  const postgresInit = `
-- Create databases for different services
CREATE DATABASE swifttrack_users;
CREATE DATABASE swifttrack_logistics;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE swifttrack_users TO swifttrack;
GRANT ALL PRIVILEGES ON DATABASE swifttrack_logistics TO swifttrack;
`;
  
  fs.writeFileSync(path.join(postgresDir, 'init.sql'), postgresInit.trim());

  // MongoDB init script
  const mongoDir = path.join(dockerDir, 'mongodb');
  if (!fs.existsSync(mongoDir)) {
    fs.mkdirSync(mongoDir, { recursive: true });
  }
  
  const mongoInit = `
// Create database and user for orders service
db = db.getSiblingDB('swifttrack_orders');
db.createUser({
  user: 'swifttrack',
  pwd: 'swifttrack123',
  roles: [{ role: 'readWrite', db: 'swifttrack_orders' }]
});
`;
  
  fs.writeFileSync(path.join(mongoDir, 'init.js'), mongoInit.trim());

  logger.info('Created Docker initialization files');
}

// Run setup if this file is executed directly
if (require.main === module) {
  setup();
}

module.exports = { setup };
