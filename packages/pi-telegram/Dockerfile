# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules and Alpine compatibility
RUN apk add --no-cache python3 make g++ libc6-compat cmake

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
# Using --legacy-peer-deps to avoid monorepo-related peer dependency conflicts
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app

# Runtime dependencies
RUN apk add --no-cache docker-cli libc6-compat

# Copy built files and node_modules from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy .pi directory (skills baked in; auth.json is git-ignored and injected via AUTH_JSON env var)
COPY .pi .pi

# Entrypoint writes auth.json from AUTH_JSON env var, then starts the bot
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
CMD ["./data"]
