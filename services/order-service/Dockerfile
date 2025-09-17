FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY ../../shared ./shared
COPY . .

EXPOSE 3003

CMD ["node", "server.js"]
