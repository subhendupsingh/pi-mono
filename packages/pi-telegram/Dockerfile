# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for workspace registration
COPY package*.json ./
COPY packages/ai/package*.json packages/ai/
COPY packages/agent/package*.json packages/agent/
COPY packages/coding-agent/package*.json packages/coding-agent/
COPY packages/pi-telegram/package*.json packages/pi-telegram/

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code for needed packages
COPY packages/ai packages/ai
COPY packages/agent packages/agent
COPY packages/coding-agent packages/coding-agent
COPY packages/pi-telegram packages/pi-telegram

# Build in order
RUN npm run build --workspace=@mariozechner/pi-ai
RUN npm run build --workspace=@mariozechner/pi-agent-core
RUN npm run build --workspace=@mariozechner/pi-coding-agent
RUN npm run build --workspace=@mariozechner/pi-telegram

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

# Install docker-cli to allow the bot to manage the sandbox container
RUN apk add --no-cache docker-cli

# Copy workspace root and node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy built packages
COPY --from=builder /app/packages/ai /app/packages/ai
COPY --from=builder /app/packages/agent /app/packages/agent
COPY --from=builder /app/packages/coding-agent /app/packages/coding-agent
COPY --from=builder /app/packages/pi-telegram /app/packages/pi-telegram

WORKDIR /app/packages/pi-telegram

# Expose data and .pi directories as volumes
VOLUME ["/app/packages/pi-telegram/data", "/app/packages/pi-telegram/.pi"]

# Entry point starts the bot. The working directory remains in the package.
ENTRYPOINT ["node", "dist/main.js"]
CMD ["./data"]
