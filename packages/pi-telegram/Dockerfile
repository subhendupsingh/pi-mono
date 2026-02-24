# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules (like koffi)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files for EVERY package to satisfy workspace requirements
COPY package*.json ./
COPY packages/ai/package*.json packages/ai/
COPY packages/agent/package*.json packages/agent/
COPY packages/coding-agent/package*.json packages/coding-agent/
COPY packages/pi-telegram/package*.json packages/pi-telegram/

# Also copy other workspace packages if they exist (even if empty) to satisfy the glob
COPY packages/tui/package*.json packages/tui/ 2>/dev/null || :
COPY packages/web-ui/package*.json packages/web-ui/ 2>/dev/null || :
COPY packages/pods/package*.json packages/pods/ 2>/dev/null || :

# Install all dependencies
RUN npm install

# Copy source code
COPY packages/ai packages/ai
COPY packages/agent packages/agent
COPY packages/coding-agent packages/coding-agent
COPY packages/pi-telegram packages/pi-telegram

# Build the required packages in order
RUN npm run build --workspace=@mariozechner/pi-ai
RUN npm run build --workspace=@mariozechner/pi-agent-core
RUN npm run build --workspace=@mariozechner/pi-coding-agent
RUN npm run build --workspace=@mariozechner/pi-telegram

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

# Install docker-cli (needed for the sandbox container)
RUN apk add --no-cache docker-cli

# Copy workspace root and node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy only the built packages needed for runtime
COPY --from=builder /app/packages/ai /app/packages/ai
COPY --from=builder /app/packages/agent /app/packages/agent
COPY --from=builder /app/packages/coding-agent /app/packages/coding-agent
COPY --from=builder /app/packages/pi-telegram /app/packages/pi-telegram

WORKDIR /app/packages/pi-telegram

# VOLUME is handled by Coolify named volumes in docker-compose.yml
ENTRYPOINT ["node", "dist/main.js"]
CMD ["./data"]
