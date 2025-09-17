const path = require('path');
const logger = require('../shared/logger');

async function runMigrations() {
  try {
    logger.info('Running database migrations...');

    // Run User Service migrations
    logger.info('Running User Service migrations...');
    const userServiceMigrations = require('../services/user-service/migrations/migrate');
    await userServiceMigrations.runMigrations();

    // Run Logistics Service migrations
    logger.info('Running Logistics Service migrations...');
    const logisticsServiceMigrations = require('../services/logistics-service/migrations/migrate');
    await logisticsServiceMigrations.runMigrations();

    logger.info('All migrations completed successfully!');
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };
