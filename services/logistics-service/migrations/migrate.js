require('dotenv').config({
  path: require('path').resolve(__dirname, '../.env'),
  override: true
});

const { Pool } = require('pg');
const logger = require('../../../shared/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const migrations = [
  {
    name: '001_create_logistics_tables',
    up: `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      
      -- Orders table (for logistics tracking)
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        driver_id UUID,
        pickup_address TEXT,
        delivery_address TEXT,
        contact_phone VARCHAR(20),
        priority VARCHAR(20) DEFAULT 'standard',
        status VARCHAR(50) DEFAULT 'created',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Driver orders assignments
      CREATE TABLE IF NOT EXISTS driver_orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        driver_id UUID NOT NULL,
        order_id VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'assigned',
        assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        accepted_at TIMESTAMP WITH TIME ZONE,
        estimated_pickup TIMESTAMP WITH TIME ZONE,
        estimated_delivery TIMESTAMP WITH TIME ZONE,
        UNIQUE(driver_id, order_id)
      );

      -- Driver locations for real-time tracking
      CREATE TABLE IF NOT EXISTS driver_locations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        driver_id UUID NOT NULL,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        heading DECIMAL(5, 2),
        speed DECIMAL(5, 2),
        recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Routes and waypoints
      CREATE TABLE IF NOT EXISTS routes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id VARCHAR(50) NOT NULL,
        driver_id UUID NOT NULL,
        optimized_route JSONB,
        total_distance DECIMAL(8, 2),
        estimated_duration INTEGER, -- in minutes
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Create indexes for performance
      CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_driver_orders_driver_id ON driver_orders(driver_id);
      CREATE INDEX IF NOT EXISTS idx_driver_orders_status ON driver_orders(status);
      CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_id ON driver_locations(driver_id);
      CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded_at ON driver_locations(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_routes_order_id ON routes(order_id);
      CREATE INDEX IF NOT EXISTS idx_routes_driver_id ON routes(driver_id);

      -- Add constraints
      ALTER TABLE driver_orders ADD CONSTRAINT fk_driver_orders_order_id 
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
      
      ALTER TABLE routes ADD CONSTRAINT fk_routes_order_id 
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
    `,
    down: `
      DROP TABLE IF EXISTS routes;
      DROP TABLE IF EXISTS driver_locations;
      DROP TABLE IF EXISTS driver_orders;
      DROP TABLE IF EXISTS orders;
    `
  }
];

async function runMigrations() {
  const client = await pool.connect();

  try {
    // Create migrations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Get executed migrations
    const result = await client.query('SELECT name FROM migrations');
    const executedMigrations = result.rows.map(row => row.name);

    // Run pending migrations
    for (const migration of migrations) {
      if (!executedMigrations.includes(migration.name)) {
        logger.info(`Running migration: ${migration.name}`);

        await client.query('BEGIN');
        try {
          await client.query(migration.up);
          await client.query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
          await client.query('COMMIT');

          logger.info(`Migration completed: ${migration.name}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }

    logger.info('All migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  runMigrations()
    .then(() => {
      logger.info('Migration process completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration process failed:', error);
      process.exit(1);
    });
}

module.exports = { runMigrations };
