# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules and Alpine compatibility
RUN apk add --no-cache python3 make g++ libc6-compat cmake git

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app

# Runtime dependencies
RUN apk add --no-cache docker-cli libc6-compat git

# Copy built files and node_modules from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy .pi directory (auth.json is excluded via .dockerignore; comes from AUTH_JSON env var)
# The pi-skills submodule is cloned fresh to avoid Coolify submodule issues
COPY --from=builder /app/.pi ./.pi
RUN rm -rf .pi/skills/pi-skills \
    && git clone --depth=1 https://github.com/badlogic/pi-skills .pi/skills/pi-skills

# Entrypoint writes auth.json from AUTH_JSON env var, then starts the bot
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
CMD ["./data"]
