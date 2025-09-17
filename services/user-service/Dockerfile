FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy shared utilities
COPY ../../shared ./shared

# Copy source code
COPY . .

EXPOSE 3002

CMD ["node", "server.js"]
