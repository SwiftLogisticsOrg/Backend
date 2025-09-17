# SwiftTrack Backend - Microservices

Production-grade Express microservices backend for SwiftTrack logistics platform.

## Architecture

```
├── api-gateway/          # API Gateway service
├── services/
│   ├── user-service/     # User management (PostgreSQL)
│   ├── order-service/    # Order management (MongoDB)
│   ├── logistics-service/ # Logistics & routing (PostgreSQL + Redis)
│   └── notification-service/ # Real-time notifications (WebSockets)
├── shared/              # Shared utilities and middleware
├── config/              # Configuration files
├── scripts/             # Setup and utility scripts
└── docker/              # Docker configurations
```

## Services

### API Gateway (Port 3001)
- Request routing and load balancing
- Authentication and authorization
- Rate limiting and request validation
- API documentation (Swagger)

### User Service (Port 3002)
- User registration and authentication
- Role-based access control (Client/Driver)
- JWT token management
- User profile management

### Order Service (Port 3003)
- Order creation and management
- Order status tracking
- Client order history
- Driver order assignments

### Logistics Service (Port 3004)
- Route optimization and planning
- Real-time tracking
- Driver management
- Delivery status updates

### Notification Service (Port 3005)
- WebSocket connections
- Real-time status updates
- Push notifications
- Event broadcasting

## Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- PostgreSQL
- MongoDB
- Redis
- RabbitMQ

### Installation

```bash
# Install dependencies
npm install

# Setup environment
npm run setup

# Start infrastructure (Docker)
npm run docker:up

# Start all services in development
npm run dev
```

### Environment Variables

Each service has its own `.env` file. Copy from `.env.example`:

```bash
# Copy environment templates
cp api-gateway/.env.example api-gateway/.env
cp services/user-service/.env.example services/user-service/.env
cp services/order-service/.env.example services/order-service/.env
cp services/logistics-service/.env.example services/logistics-service/.env
cp services/notification-service/.env.example services/notification-service/.env
```

## API Documentation

Once running, access Swagger documentation at:
- API Gateway: http://localhost:3001/api-docs
- Individual services: http://localhost:300X/api-docs

## Production Deployment

```bash
# Build Docker images
npm run docker:build

# Start production stack
docker-compose -f docker-compose.prod.yml up -d
```

## Development

### Running Individual Services

```bash
cd services/user-service && npm run dev
cd services/order-service && npm run dev
cd services/logistics-service && npm run dev
cd services/notification-service && npm run dev
cd api-gateway && npm run dev
```

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Individual service tests
cd services/user-service && npm test
```

### Database Migrations

```bash
# Run migrations
npm run migrate

# Individual service migrations
cd services/user-service && npm run migrate
cd services/logistics-service && npm run migrate
```

## Message Broker Events

### Published Events
- `user.created`
- `user.updated`
- `order.created`
- `order.status.updated`
- `driver.assigned`
- `delivery.completed`

### Consumed Events
- `notification.send`
- `logistics.route.update`
- `driver.location.update`

## Security Features

- JWT authentication with refresh tokens
- Role-based access control
- Rate limiting
- Request validation
- CORS configuration
- Helmet security headers
- Input sanitization

## Monitoring & Logging

- Winston logging with log levels
- Request/response logging
- Error tracking
- Performance metrics
- Health check endpoints

## License

MIT License - see LICENSE file for details.
