# WMS Adapter — README

Lightweight Node.js WMS Adapter that connects your backend event bus (RabbitMQ) to a WMS mock server (TCP JSON-lines).
It receives `order.created` events from RabbitMQ, sends `receive_package` commands to the WMS TCP server, listens for WMS events (`ack`, `package_ready`, `package_loaded`, …) and republishes them to RabbitMQ as `wms.package.*` events.

This README explains what’s included, how to run it (locally or in Docker), configuration, message formats, typical flows, testing steps, and troubleshooting.

---

## Table of contents

- ### Overview
- ### Contents of this folder
- ### Prerequisites
- ### Configuration (env vars)
- ### Install
- ### Run

  - Local (development)
  - Docker
  - docker-compose

- # How it works (behavior & flow)
- # Message contracts

  - Incoming RabbitMQ command (what adapter consumes)
  - Sent to WMS (TCP JSON-lines)
  - Received from WMS (TCP JSON-lines)
  - Published to RabbitMQ (routing keys)

- # Correlation map (orderId ↔ packageId)
- # Testing & manual commands
- # Logs & expected output
- # Troubleshooting
- # Extending & production notes

---

# Overview

The WMS Adapter is a bridge between:

- RabbitMQ (exchange `orders`) — consumes `order.created` messages
- WMS mock (TCP JSON-lines) — registers as an adapter, sends commands, receives events
- RabbitMQ — republishes WMS events as `wms.package.*` messages so order-service and notification-service can react

It was designed to be simple, robust to reconnects, and easy to run for demos.

---

# Contents of this folder

```
wms-adapter/
  ├─ package.json
  ├─ index.js            # main adapter code
  ├─ Dockerfile          # optional
  └─ README.md           # this file
```

---

# Prerequisites

- Node.js 18+ (if running locally)
- RabbitMQ (accessible via `RABBIT_URL`) — management UI helpful
- WMS mock server running and reachable at `WMS_HOST:WMS_PORT` (default `localhost:5001`)
- Docker & docker-compose (optional, if using containers)

---

# Configuration (environment variables)

You can set these using `.env`, system env, or docker environment.

| Env var               |                                          Default | Description                                    |
| --------------------- | -----------------------------------------------: | ---------------------------------------------- |
| `RABBIT_URL`          | `amqp://swifttrack:swifttrack123@localhost:5672` | RabbitMQ connection URL                        |
| `EXCHANGE`            |                                         `orders` | Topic exchange name to use                     |
| `QUEUE_NAME`          |                                  `wms-adapter-q` | Queue name to create and consume               |
| `WMS_HOST`            |                                      `localhost` | Host or DNS name of WMS TCP server             |
| `WMS_PORT`            |                                           `3008` | Port of WMS TCP server                         |
| `ADAPTER_ID`          |                               `wms-adp-<random>` | Adapter identifier sent to WMS on registration |
| `RECONNECT_RABBIT_MS` |                                           `3000` | Retry millis for Rabbit reconnects             |
| `RECONNECT_WMS_MS`    |                                           `3000` | Retry millis for WMS TCP reconnects            |

---

# Install

```bash
# from inside wms-adapter/
npm install
```

(If using Docker you can skip local install.)

---

# Run

## Local (development)

```bash
# ensure RabbitMQ and WMS mock are running and accessible
export RABBIT_URL=amqp://swifttrack:swifttrack123@localhost:5672
export WMS_HOST=127.0.0.1
export WMS_PORT=3008
npm start

# or simply run from inside this dir
node index.js
```

## Docker (build & run)

```bash
# build
docker build -t wms-adapter:latest .

# run (example)
docker run --rm \
  -e RABBIT_URL=amqp://rabbitmq \
  -e WMS_HOST=wms-mock \
  -e WMS_PORT=3008 \
  wms-adapter:latest
```

## docker-compose snippet

Add to your project `docker-compose.yml` (adapt names/paths):

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"

  wms-mock:
    build: ./wms-mock
    ports:
      - "3008:3008"
      - "3001:3001"

  wms-adapter:
    build: ./wms-adapter
    environment:
      - RABBIT_URL=amqp://rabbitmq
      - EXCHANGE=orders
      - WMS_HOST=wms-mock
      - WMS_PORT=3008
      - ADAPTER_ID=wms-demo-1
    depends_on:
      - rabbitmq
      - wms-mock
```

Start:

```bash
docker-compose up wms-mock rabbitmq wms-adapter
```

---

# How it works (behavior & flow)

1. **Startup**

   - Connects to the WMS TCP server (`WMS_HOST:WMS_PORT`) and sends a registration message:

     ```json
     {
       "type": "register_adapter",
       "adapterId": "<ADAPTER_ID>",
       "capabilities": ["receive", "scan", "load"]
     }
     ```

   - Connects to RabbitMQ (`RABBIT_URL`), asserts exchange `orders` (topic) and asserts queue `wms-adapter-q`, binding to `order.created`.

2. **Consume `order.created`**

   - Waits on queue `wms-adapter-q`. When a message with routing key `order.created` arrives, adapter:

     - Validates payload (needs `orderId`).
     - Sends `receive_package` JSON-line to WMS:

       ```json
       {
         "type":"receive_package",
         "orderId":"o123",
         "clientOrderRef":"o123",
         "items":[...],
         "pickup":"..",
         "delivery":"..",
         "contact":".."
       }
       ```

     - If WMS is not connected, the adapter NACKs the message (requeue) so it can be retried later.

3. **Listen for WMS events**

   - The adapter reads newline-delimited JSON from the WMS socket.
   - For events such as `ack`, `package_received`, `package_ready`, `package_scanned`, `package_loaded`, `error`, the adapter publishes messages to the `orders` exchange using routing keys:

     - `wms.package.ack`
     - `wms.package.received`
     - `wms.package.ready`
     - `wms.package.scanned`
     - `wms.package.loaded`
     - `wms.package.error`

4. **Correlation**

   - When an `ack` arrives with `packageId` and `orderId`, the adapter stores `orderId → packageId` mapping so subsequent WMS events (which may include only `packageId`) can be published with both `orderId` and `packageId` fields.

5. **Reconnects**

   - The adapter implements simple reconnect logic for both RabbitMQ and WMS. On connection loss it will attempt to reconnect after `RECONNECT_*_MS`.

---

# Message contracts

### What adapter consumes (RabbitMQ)

- Exchange: `orders` (topic)
- Routing key to bind: `order.created`
- Example payload:

```json
{
  "orderId": "o123",
  "clientId": "u1",
  "pickup": "123 A St",
  "delivery": "456 B Ave",
  "items": [{ "name": "Phone", "qty": 1 }],
  "contact": "0770000000"
}
```

### What adapter sends to WMS (TCP JSON-lines)

- `register_adapter` (on connect)
- `receive_package` as above
- format: single-line JSON string terminated by `\n`

### What adapter receives from WMS (TCP JSON-lines)

- Example `ack`:

```json
{
  "type": "ack",
  "messageId": "m-001",
  "status": "received",
  "packageId": "pkg-1001",
  "orderId": "o123"
}
```

- `package_ready`, `package_loaded`, `package_scanned`, `package_received`, `error` (see WMS mock README for full shapes)

### What adapter publishes to RabbitMQ (routing keys)

| WMS event          | Routing key published  | Sample published payload                            |
| ------------------ | ---------------------- | --------------------------------------------------- |
| `ack`              | `wms.package.ack`      | `{ packageId, orderId, raw, timestamp }`            |
| `package_received` | `wms.package.received` | `{ packageId, orderId, raw, timestamp }`            |
| `package_ready`    | `wms.package.ready`    | `{ packageId, orderId, raw, timestamp }`            |
| `package_scanned`  | `wms.package.scanned`  | `{ packageId, orderId, scanPoint, raw, timestamp }` |
| `package_loaded`   | `wms.package.loaded`   | `{ packageId, orderId, vehicleId, raw, timestamp }` |
| `error`            | `wms.package.error`    | `{ packageId?, orderId?, raw, message, timestamp }` |

- Exchange: `orders`
- Persistence: messages published non-persistent (for demo). In production, consider `persistent: true`.

---

# Correlation map (orderId ↔ packageId)

- The adapter keeps an `orderToPackage` map populated on `ack` events (when WMS returns `packageId` and `orderId`).
- Later WMS events may only carry `packageId`. Adapter looks up `orderId` so RabbitMQ messages include both.

---

# Testing & manual commands

### 1) Start dependencies

- Ensure RabbitMQ and WMS mock are running. If using docker-compose:

```bash
docker-compose up rabbitmq wms-mock
```

### 2) Start adapter (locally)

```bash
cd wms-adapter
RABBIT_URL=amqp://swifttrack:swifttrack123@localhost:5672 WMS_HOST=127.0.0.1 WMS_PORT=3008 npm start
```

### 3) Publish a test `order.created` event

You can use `rabbitmqadmin` inside RabbitMQ container or a small publisher script. Example with `rabbitmqadmin` (inside container):

```bash
docker exec -it swifttrack-rabbitmq rabbitmqadmin -u swifttrack -p swifttrack123 publish exchange=orders routing_key=order.created payload='{"orderId":"o123","clientId":"u1","pickup":"123 A St","delivery":"456 B Ave","items":[{"name":"Phone","qty":1}],"contact":"0770000000"}'
```

Or create a small node script `publish-order.js` that connects to RabbitMQ and publishes the payload.

### 4) Observe flows

- WMS mock will reply with `ack` and later `package_ready`/`package_loaded`.
- Adapter logs will show messages sent and published.
- RabbitMQ management UI ([http://localhost:15672](http://localhost:15672)) can be used to view messages and bindings.

---

# Logs & expected output

Adapter logs useful messages. Example snippets:

```
[AMQP] connecting to amqp://localhost
[WMS] connected to localhost:3008
[AMQP] waiting for messages on queue: wms-adapter-q
[AMQP] Received order.created: { orderId: 'o123', ... }
-> WMS {"type":"receive_package","orderId":"o123",...}
<- WMS {"type":"ack","messageId":"m-1","packageId":"pkg-ABCD","orderId":"o123"}
[AMQP] published wms.package.ack: { packageId: 'pkg-ABCD', orderId: 'o123', ... }
<- WMS {"type":"package_ready", "packageId":"pkg-ABCD", ...}
[AMQP] published wms.package.ready: {...}
```

---

# Troubleshooting

**Problem:** Adapter fails to connect to RabbitMQ

- Check `RABBIT_URL` value.
- Verify RabbitMQ is up (`docker ps`, [http://localhost:15672](http://localhost:15672)).
- Look for firewall/port mappings.

**Problem:** Adapter cannot connect to WMS TCP server

- Check `WMS_HOST` & `WMS_PORT`. If running in Docker, use service name (e.g., `wms-mock`) not `localhost`.
- Use `nc` to test: `nc -vz <host> <port>` or connect and manually send `register_adapter` JSON.

**Problem:** Messages get consumed but nothing published to RabbitMQ

- Check adapter logs for parsing errors.
- Ensure `amqpCh` exists and `exchange` has been asserted.
- Confirm published routing keys using RabbitMQ UI / consumers.

**Problem:** `order.created` messages requeued (adapter NACKs)

- Adapter couldn't send `receive_package` (WMS offline). Ensure WMS mock is reachable. Adapter will requeue so another attempt will occur later.

---

# Extending & production notes

- Make published messages persistent (`persistent: true`) and use durable queues in production.
- Add DLQ handling for poisoned messages.
- Replace in-memory correlation map with Redis (or DB) for durability across restarts.
- Add health-check HTTP endpoint and Prometheus metrics for monitoring.
- Secure RabbitMQ connection with TLS and use credentials with least privilege.
- Add authentication with WMS if your real WMS requires it.

---
