const Joi = require('joi');

// Define paginationQuery first
const paginationQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().optional(),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
});

// Define orderQuery using paginationQuery
const orderQuery = Joi.object({
  status: Joi.string().valid(
    'created', 'assigned', 'accepted', 'en_route_pickup', 
    'arrived_pickup', 'picked_up', 'en_route_delivery', 
    'arrived_delivery', 'delivered', 'cancelled'
  ).optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  clientId: Joi.string().optional(),
  driverId: Joi.string().optional()
}).concat(paginationQuery);

const validation = {
  // User validation schemas
  registerUser: Joi.object({
    name: Joi.string().min(2).max(50).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8).pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])')).required()
      .messages({
        'string.pattern.base': 'Password must contain at least one lowercase letter, one uppercase letter, one number and one special character'
      }),
    role: Joi.string().valid('client', 'driver').default('client'),
    phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).optional()
  }),

  loginUser: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  }),

  updateProfile: Joi.object({
    name: Joi.string().min(2).max(50).optional(),
    phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).optional(),
    vehicle: Joi.string().max(50).optional() // For drivers
  }),

  // Order validation schemas
  createOrder: Joi.object({
    pickupAddress: Joi.string().min(10).max(200).required(),
    pickupCoordinates: Joi.object({
      latitude: Joi.number().min(-90).max(90).required(),
      longitude: Joi.number().min(-180).max(180).required()
    }).required(),
    deliveryAddress: Joi.string().min(10).max(200).required(),
    deliveryCoordinates: Joi.object({
      latitude: Joi.number().min(-90).max(90).required(),
      longitude: Joi.number().min(-180).max(180).required()
    }).required(),
    items: Joi.array().items(
      Joi.object({
        name: Joi.string().min(1).max(100).required(),
        quantity: Joi.number().integer().min(1).required(),
        weight: Joi.number().positive().optional(),
        dimensions: Joi.object({
          length: Joi.number().positive(),
          width: Joi.number().positive(),
          height: Joi.number().positive()
        }).optional()
      })
    ).min(1).required(),
    contactPhone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).required(),
    notes: Joi.string().max(500).optional(),
    scheduledPickup: Joi.date().min('now').optional(),
    priority: Joi.string().valid('standard', 'express', 'urgent').default('standard')
  }),

  updateOrderStatus: Joi.object({
    status: Joi.string().valid(
      'created', 'assigned', 'accepted', 'en_route_pickup', 
      'arrived_pickup', 'picked_up', 'en_route_delivery', 
      'arrived_delivery', 'delivered', 'cancelled'
    ).required(),
    location: Joi.object({
      latitude: Joi.number().min(-90).max(90),
      longitude: Joi.number().min(-180).max(180)
    }).optional(),
    notes: Joi.string().max(500).optional(),
    proofUrl: Joi.string().uri().optional()
  }),

  // Driver validation schemas
  acceptOrder: Joi.object({
    estimatedArrival: Joi.date().min('now').optional()
  }),

  updateLocation: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    heading: Joi.number().min(0).max(360).optional(),
    speed: Joi.number().min(0).optional()
  }),

  // Query validation schemas
  paginationQuery,
  orderQuery
};

const validateRequest = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body);
    if (error) {
      const errorMessage = error.details.map(detail => detail.message).join(', ');
      return res.status(400).json({ 
        error: 'Validation error', 
        details: errorMessage 
      });
    }
    req.body = value;
    next();
  };
};

const validateQuery = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query);
    if (error) {
      const errorMessage = error.details.map(detail => detail.message).join(', ');
      return res.status(400).json({ 
        error: 'Query validation error', 
        details: errorMessage 
      });
    }
    req.query = value;
    next();
  };
};

module.exports = {
  schemas: validation,
  validateRequest,
  validateQuery
};
