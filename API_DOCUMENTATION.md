# SwiftTrack API Documentation

## Base URL
- Development: `http://localhost:3001`
- Production: `https://api.yourdomain.com`

## Authentication
All authenticated endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## Response Format
All API responses follow this format:
```json
{
  "success": true,
  "data": { ... },
  "error": "Error message (if success is false)"
}
```

## Endpoints

### Authentication

#### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePass123!",
  "role": "client",
  "phone": "+1234567890"
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

#### Refresh Token
```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "your-refresh-token"
}
```

### Users

#### Get Current User
```http
GET /api/users/me
Authorization: Bearer <token>
```

#### Update Profile
```http
PUT /api/users/me
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Updated Name",
  "phone": "+1987654321",
  "vehicle": "Van-01" // For drivers only
}
```

#### Get All Drivers (Admin only)
```http
GET /api/users/drivers
Authorization: Bearer <token>
```

### Orders

#### Create Order (Clients only)
```http
POST /api/orders
Authorization: Bearer <token>
Content-Type: application/json

{
  "pickupAddress": "123 Main St, City A",
  "pickupCoordinates": {
    "latitude": 37.7749,
    "longitude": -122.4194
  },
  "deliveryAddress": "456 Oak Ave, City B",
  "deliveryCoordinates": {
    "latitude": 37.7849,
    "longitude": -122.4094
  },
  "items": [
    {
      "name": "Electronics Package",
      "quantity": 1,
      "weight": 2.5
    }
  ],
  "contactPhone": "+1234567890",
  "notes": "Handle with care",
  "priority": "standard",
  "scheduledPickup": "2025-01-12T10:00:00Z"
}
```

**Note:** Coordinates are required for both pickup and delivery locations. These coordinates are used by the ROS (Robot Operating System) adapter for route optimization and autonomous vehicle navigation. 

Coordinate Requirements:
- `latitude`: Number between -90 and 90 (degrees)
- `longitude`: Number between -180 and 180 (degrees)
- Coordinates should be in decimal degrees format (WGS84)

#### Get Orders
```http
GET /api/orders?status=created&page=1&limit=20
Authorization: Bearer <token>
```

Query Parameters:
- `status`: Filter by order status
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20)
- `startDate`: Filter orders from date
- `endDate`: Filter orders to date

#### Get Order by ID
```http
GET /api/orders/{orderId}
Authorization: Bearer <token>
```

#### Update Order Status (Drivers/Admin only)
```http
PATCH /api/orders/{orderId}/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "picked_up",
  "location": {
    "latitude": 40.7128,
    "longitude": -74.0060
  },
  "notes": "Package picked up successfully",
  "proofUrl": "https://example.com/proof.jpg"
}
```

#### Assign Order to Driver (Admin only)
```http
PATCH /api/orders/{orderId}/assign
Authorization: Bearer <token>
Content-Type: application/json

{
  "driverId": "driver-uuid",
  "estimatedPickup": "2025-01-12T11:00:00Z",
  "estimatedDelivery": "2025-01-12T15:00:00Z"
}
```

### Driver Operations

#### Get Driver Orders
```http
GET /api/drivers/{driverId}/orders
Authorization: Bearer <token>
```

#### Accept Order
```http
POST /api/drivers/{driverId}/orders/{orderId}/accept
Authorization: Bearer <token>
Content-Type: application/json

{
  "estimatedArrival": "2025-01-12T11:30:00Z"
}
```

#### Update Driver Location
```http
POST /api/drivers/{driverId}/location
Authorization: Bearer <token>
Content-Type: application/json

{
  "latitude": 40.7128,
  "longitude": -74.0060,
  "heading": 90,
  "speed": 25.5
}
```

#### Get Driver Location
```http
GET /api/drivers/{driverId}/location
Authorization: Bearer <token>
```

### Logistics

#### Find Nearby Drivers
```http
GET /api/logistics/nearby-drivers?latitude=40.7128&longitude=-74.0060&radius=10&limit=5
Authorization: Bearer <token>
```

#### Optimize Route
```http
POST /api/logistics/optimize-route
Authorization: Bearer <token>
Content-Type: application/json

{
  "pickupAddress": "123 Main St, City A",
  "deliveryAddress": "456 Oak Ave, City B"
}
```

#### Calculate ETA
```http
POST /api/logistics/eta
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentLocation": {
    "latitude": 40.7128,
    "longitude": -74.0060
  },
  "destinationAddress": "456 Oak Ave, City B"
}
```

### Notifications

#### Send Notification
```http
POST /api/notifications/send
Authorization: Bearer <token>
Content-Type: application/json

{
  "userId": "user-uuid",
  "event": "order:status:updated",
  "data": {
    "orderId": "ord-123",
    "status": "delivered",
    "message": "Your order has been delivered"
  }
}
```

#### Broadcast to Role
```http
POST /api/notifications/broadcast
Authorization: Bearer <token>
Content-Type: application/json

{
  "role": "driver",
  "event": "order:available",
  "data": {
    "orderId": "ord-123",
    "priority": "urgent",
    "message": "New urgent order available"
  }
}
```

#### Get Notification Stats
```http
GET /api/notifications/stats
Authorization: Bearer <token>
```

## WebSocket Events

### Connection
Connect to WebSocket with JWT token:
```javascript
const socket = io('http://localhost:3001', {
  auth: {
    token: 'your-jwt-token'
  }
});
```

### Client Events (Emit)
- `location:update` - Driver location update
- `track:order` - Subscribe to order tracking
- `untrack:order` - Unsubscribe from order tracking

### Server Events (Listen)
- `connected` - Connection confirmation
- `order:status:updated` - Order status change
- `order:assigned` - New order assignment (drivers)
- `driver:assigned` - Driver assigned to order (clients)
- `driver:location` - Driver location update
- `order:created` - Order creation confirmation

## Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request / Validation Error
- `401` - Unauthorized / Token Required
- `403` - Forbidden / Insufficient Permissions
- `404` - Not Found
- `429` - Too Many Requests (Rate Limited)
- `500` - Internal Server Error

## Order Status Flow

1. `created` - Order created by client
2. `assigned` - Order assigned to driver
3. `accepted` - Driver accepted the order
4. `en_route_pickup` - Driver heading to pickup
5. `arrived_pickup` - Driver arrived at pickup location
6. `picked_up` - Package picked up
7. `en_route_delivery` - Driver heading to delivery
8. `arrived_delivery` - Driver arrived at delivery location
9. `delivered` - Package delivered
10. `cancelled` - Order cancelled

## Rate Limiting

- API Gateway: 100 requests per 15 minutes per IP
- Authentication endpoints: Lower limits apply
- WebSocket connections: No rate limiting

## Error Handling

All errors return a consistent format:
```json
{
  "success": false,
  "error": "Error message",
  "details": "Additional error details (in development)"
}
```

## Interactive Documentation

Visit `http://localhost:3001/api-docs` for interactive Swagger documentation when the services are running.
