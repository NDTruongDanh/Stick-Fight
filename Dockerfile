# Single-stage LAN host image: build the web client, run the WS host server.
FROM node:20-alpine

WORKDIR /app

# Install deps first (better layer cache).
COPY package.json package-lock.json ./
RUN npm ci

# Build client (tsc + vite build -> dist/).
COPY . .
RUN npm run build

EXPOSE 8080

# Run the authoritative LAN server by default.
CMD ["npm", "run", "host"]
