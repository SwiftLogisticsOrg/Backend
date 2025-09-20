require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const morgan = require('morgan');

const logger = require('../../shared/logger');
const { generateTokens, verifyRefreshToken } = require('../../shared/auth');
const { validateRequest } = require('../../shared/validation');
const { asyncHandler, errorHandler, notFound } = require('../../shared/errorHandler');
const messageBroker = require('../../shared/messageBroker');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3002;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect()
  .then(() => logger.info('User Service: Connected to PostgreSQL'))
  .catch(err => logger.error('User Service: PostgreSQL connection error:', err));

// Middleware
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'user-service'
  });
});

// User model functions
const UserModel = {
  async create(userData) {
    const { name, email, password, role = 'client', phone } = userData;
    const hashedPassword = await bcrypt.hash(password, 12);
    const id = uuidv4();
    
    const query = `
      INSERT INTO users (id, name, email, password, role, phone, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING id, name, email, role, phone, created_at, updated_at
    `;
    
    const result = await pool.query(query, [id, name, email, hashedPassword, role, phone]);
    return result.rows[0];
  },

  async findByEmail(email) {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await pool.query(query, [email]);
    return result.rows[0];
  },

  async findById(id) {
    const query = `
      SELECT id, name, email, role, phone, vehicle, created_at, updated_at 
      FROM users WHERE id = $1
    `;
    const result = await pool.query(query, [id]);
    return result.rows[0];
  },

  async update(id, updateData) {
    const { name, phone, vehicle } = updateData;
    const query = `
      UPDATE users 
      SET name = COALESCE($2, name), 
          phone = COALESCE($3, phone),
          vehicle = COALESCE($4, vehicle),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, email, role, phone, vehicle, created_at, updated_at
    `;
    
    const result = await pool.query(query, [id, name, phone, vehicle]);
    return result.rows[0];
  },

  async getAllDrivers() {
    const query = `
      SELECT id, name, email, phone, vehicle, created_at, updated_at 
      FROM users WHERE role = 'driver'
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  }
};

// Routes

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 50
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *               role:
 *                 type: string
 *                 enum: [client, driver]
 *                 default: client
 *               phone:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Validation error or user already exists
 */
app.post('/api/auth/register', 
  validateRequest(require('../../shared/validation').schemas.registerUser),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, phone } = req.body;

    // Check if user already exists
    const existingUser = await UserModel.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    // Create user
    const user = await UserModel.create({ name, email, password, role, phone });
    
    // Generate tokens
    const tokens = generateTokens(user);

    // Publish user created event
    await messageBroker.publish(
      messageBroker.exchanges.USERS,
      'user.created',
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        timestamp: new Date().toISOString()
      }
    );

    logger.info('User registered:', { userId: user.id, email: user.email, role: user.role });

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone
        },
        ...tokens
      }
    });
  })
);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
app.post('/api/auth/login',
  validateRequest(require('../../shared/validation').schemas.loginUser),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Find user
    const user = await UserModel.findByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate tokens
    const tokens = generateTokens(user);

    logger.info('User logged in:', { userId: user.id, email: user.email });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone
        },
        ...tokens
      }
    });
  })
);

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *       401:
 *         description: Invalid refresh token
 */
app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const user = await UserModel.findById(payload.id);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const tokens = generateTokens(user);

    res.json({
      success: true,
      data: tokens
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
}));

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get current user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *       401:
 *         description: Unauthorized
 */
app.get('/api/users/me', asyncHandler(async (req, res) => {
  const userId = req.headers['x-user-id'];
  
  if (!userId) {
    return res.status(401).json({ error: 'User ID required' });
  }

  const user = await UserModel.findById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    success: true,
    data: user
  });
}));

/**
 * @swagger
 * /api/users/me:
 *   put:
 *     summary: Update current user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 50
 *               phone:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *               vehicle:
 *                 type: string
 *                 maxLength: 50
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
app.put('/api/users/me',
  validateRequest(require('../../shared/validation').schemas.updateProfile),
  asyncHandler(async (req, res) => {
    const userId = req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const updatedUser = await UserModel.update(userId, req.body);
    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Publish user updated event
    await messageBroker.publish(
      messageBroker.exchanges.USERS,
      'user.updated',
      {
        userId: updatedUser.id,
        changes: req.body,
        timestamp: new Date().toISOString()
      }
    );

    logger.info('User profile updated:', { userId: updatedUser.id });

    res.json({
      success: true,
      data: updatedUser
    });
  })
);

/**
 * @swagger
 * /api/users/drivers:
 *   get:
 *     summary: Get all drivers (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Drivers retrieved successfully
 *       401:
 *         description: Unauthorized
 */
app.get('/api/users/drivers', asyncHandler(async (req, res) => {
  const userRole = req.headers['x-user-role'];
  
  if (userRole !== 'admin' && userRole !== 'driver') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const drivers = await UserModel.getAllDrivers();

  res.json({
    success: true,
    data: drivers
  });
}));

// Error handling
app.use(notFound);
app.use(errorHandler);

// Initialize message broker and start server
async function startServer() {
  try {
    await messageBroker.connect();
    
    app.listen(PORT, () => {
      logger.info(`User Service running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start User Service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await messageBroker.close();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await messageBroker.close();
  await pool.end();
  process.exit(0);
});

startServer();

module.exports = app;
