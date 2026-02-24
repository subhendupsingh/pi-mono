# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules (like koffi)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies from npm
# This will pull @mariozechner/* from the public registry
RUN npm install

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app

# Install docker-cli for the sandbox
RUN apk add --no-cache docker-cli

# Copy built files and node_modules from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Entry point starts the bot.
ENTRYPOINT ["node", "dist/main.js"]
CMD ["./data"]
