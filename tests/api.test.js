const request = require('supertest');
const app = require('../api-gateway/server');

describe('API Gateway', () => {
  test('Health check should return 200', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.body.status).toBe('healthy');
    expect(response.body.service).toBe('api-gateway');
  });

  test('Service status should return gateway and services info', async () => {
    const response = await request(app)
      .get('/api/status')
      .expect(200);
    
    expect(response.body.gateway).toBeDefined();
    expect(response.body.services).toBeDefined();
  });

  test('Swagger docs should be accessible', async () => {
    const response = await request(app)
      .get('/api-docs')
      .expect(301); // Redirect to /api-docs/
  });
});

describe('Authentication', () => {
  test('Login without credentials should return 400', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({})
      .expect(400);
    
    expect(response.body.error).toBe('Validation error');
  });

  test('Register without required fields should return 400', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'test@example.com'
        // Missing name and password
      })
      .expect(400);
    
    expect(response.body.error).toBe('Validation error');
  });
});

describe('Protected Routes', () => {
  test('Access protected route without token should return 401', async () => {
    const response = await request(app)
      .get('/api/users/me')
      .expect(401);
    
    expect(response.body.error).toBe('Access token required');
  });

  test('Access protected route with invalid token should return 403', async () => {
    const response = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer invalid-token')
      .expect(403);
    
    expect(response.body.error).toBe('Invalid or expired token');
  });
});
