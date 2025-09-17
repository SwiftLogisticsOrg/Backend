# How this adapter works and what it expectss

## 1. order service publishes

```
{
  "orderId": "o123",
  "clientId": "u1",
  "pickup": "123 A St",
  "delivery": "456 B Ave",
  "items": [{"name":"Phone","qty":1}],
  "contact": "077xxxxxxx"
}
```

with routing key order.created.

## 2. CMS Adapter receives event, builds SOAP XML, calls CMS mock at /soap.

## 3. CMS Mock responds:

```
<CreateOrderResponse>
  <Success>true</Success>
  <CmsOrderId>CMS-1234</CmsOrderId>
  <BillingRef>INV-2025-0001</BillingRef>
  <Message>Order accepted</Message>
</CreateOrderResponse>
```

## 4. CMS Adapter publishes event with routing key cms.order.created:

```
{
  "cmsOrderId": "CMS-1234",
  "billingRef": "INV-2025-0001",
  "localOrderId": "o123",
  "clientId": "u1",
  "status": "cms_created",
  "message": "Order accepted",
  "correlationId": "..."
}
```

## 5. Other services (order-service, notification-service) consume this event to update order state.

---

# How to test

### 1. Run CMS mock (node index.js in cms_server/).

This cms_server is not in this repo, it is in mock servers repo. in that repo go inside /cms_server and run the above command and get the server up and running

### 2. Run RabbitMQ (docker-compose up rabbitmq).

This should be run from the root dir where docker-compose.yml resides. go to our root dir and run this then it will only start rabbitmq which is needed for this adapter to work. later we will start all the services in docker-compose when we are fully finished and ready for deployemnt.

### 3. Run adapter (npm start in cms-adapter/).

This command should run from inside this current dir

### 4. Publish an event manually:

```
docker exec -it swifttrack-rabbitmq rabbitmqadmin -u swifttrack -p swifttrack123 publish exchange=orders routing_key=order.created payload='{"orderId":"o123","clientId":"u1","pickup":"123 A St","delivery":"456 B Ave","items":[{"name":"Phone","qty":1}],"contact":"077xxxxxxx"}'
```

### 5. Watch adapter logs: it should log SOAP request/response and publish cms.order.created.

### 6. Check CMS mock logs (GET /admin/orders).

---
