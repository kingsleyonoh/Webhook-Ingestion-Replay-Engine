# --- Stage 1: Builder ---
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency files first (cache layer)
COPY package*.json ./
RUN npm ci

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-alpine AS production

# Security: non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files and install production-only deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy migration files for drizzle-kit migrate
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY drizzle.config.ts ./

# Switch to non-root
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

EXPOSE 3000

CMD ["node", "dist/server.js"]
