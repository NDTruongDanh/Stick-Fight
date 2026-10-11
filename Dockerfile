# Single-stage LAN room-server image: build the web client, serve it + the WS
# room server together on :8080 (dist/ is already built, so skip the rebuild).
FROM node:20-alpine

WORKDIR /app

# Install deps first (better layer cache).
COPY package.json package-lock.json ./
RUN npm ci

# Build client (tsc + vite build -> dist/).
COPY . .
RUN npm run build

EXPOSE 8080

# Serve the built client + run the authoritative LAN room server together.
CMD ["npm", "run", "host:quick"]
