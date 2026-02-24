# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules and Alpine compatibility
RUN apk add --no-cache python3 make g++ libc6-compat cmake

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
RUN apk add --no-cache docker-cli libc6-compat

# Copy built files and node_modules from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy .pi directory (auth.json is excluded via .dockerignore; comes from AUTH_JSON env var)
# pi-skills is tracked as regular files in git, so it's included in the build context
COPY --from=builder /app/.pi ./.pi

# Stage skills to a separate dir that won't be overlaid by named volume.
# The entrypoint syncs these into the shared /app/.pi/skills volume at startup.
RUN cp -r /app/.pi/skills /app/.pi-skills-stage

# Entrypoint writes auth.json from AUTH_JSON env var, then starts the bot
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
CMD ["./data"]
