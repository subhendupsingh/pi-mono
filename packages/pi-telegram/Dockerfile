# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules (like koffi)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# In a monorepo, we MUST have the root package.json and the packages we depend on.
# These dependencies are local to the monorepo and not on the public npm registry.
COPY package*.json ./
COPY packages/ai/package*.json packages/ai/
COPY packages/agent/package*.json packages/agent/
COPY packages/coding-agent/package*.json packages/coding-agent/
COPY packages/pi-telegram/package*.json packages/pi-telegram/

# Install dependencies (this links the local workspaces)
RUN npm install

# Copy source code for only the packages we need
COPY packages/ai packages/ai
COPY packages/agent packages/agent
COPY packages/coding-agent packages/coding-agent
COPY packages/pi-telegram packages/pi-telegram

# Build the dependencies first, then the bot
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

# We need the built files of the dependent packages for runtime too!
COPY --from=builder /app/packages/ai /app/packages/ai
COPY --from=builder /app/packages/agent /app/packages/agent
COPY --from=builder /app/packages/coding-agent /app/packages/coding-agent
COPY --from=builder /app/packages/pi-telegram /app/packages/pi-telegram

WORKDIR /app/packages/pi-telegram

ENTRYPOINT ["node", "dist/main.js"]
CMD ["./data"]
