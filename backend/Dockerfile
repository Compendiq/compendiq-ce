# syntax=docker/dockerfile:1
# Build stage — compile TypeScript to JavaScript
# NOTE: node:24-alpine is the floating tag for Node 24 on Alpine Linux.
# Both linux/amd64 and linux/arm64 variants are published by the Node.js Docker
# team. The floating tag always resolves to the current stable Alpine pairing.
FROM node:24-alpine AS builder

# Install build dependencies for native modules (bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,target=/root/.npm npm ci -w backend -w @atlasmind/contracts
COPY packages/contracts/ ./packages/contracts/
RUN npm run build -w @atlasmind/contracts
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src/ backend/src/
RUN npm run build -w backend

# Separate stage to build production dependencies with native bindings
FROM node:24-alpine AS prod-deps

# Install build dependencies for native modules (bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,target=/root/.npm npm ci -w backend -w @atlasmind/contracts --omit=dev

# Utility stage — install runtime tools and prepare filesystem
FROM node:24-alpine AS tools

RUN apk add --no-cache dumb-init wget

# Prepare the app directory with correct ownership for node (uid 1000)
RUN mkdir -p /opt/app/data && chown -R 1000:1000 /opt/app

# Chromium stage — install Chromium into a standard Alpine base.
###########################################################
# Runtime stage — node:24-alpine with only what's needed
# node:24-alpine is a multi-arch image (linux/amd64 + linux/arm64).
FROM node:24-alpine AS runtime

# Copy runtime utilities from tools stage
COPY --from=tools /usr/bin/dumb-init /usr/bin/dumb-init
COPY --from=tools /usr/bin/wget /usr/bin/wget
# Copy pre-created data directory with correct ownership
COPY --from=tools --chown=node:node /opt/app/data /app/data

WORKDIR /app
COPY --chown=node:node --from=builder /app/backend/package.json ./
# Copy production node_modules (hoisted to root by npm workspaces)
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
# Copy built contracts package so backend can resolve it at runtime
COPY --chown=node:node --from=builder /app/packages/contracts/dist/ ./node_modules/@atlasmind/contracts/dist/
COPY --chown=node:node --from=builder /app/packages/contracts/package.json ./node_modules/@atlasmind/contracts/package.json
# Copy compiled backend
COPY --chown=node:node --from=builder /app/backend/dist/ dist/
# Copy SQL migration files (not emitted by tsc)
COPY --chown=node:node --from=builder /app/backend/src/core/db/migrations/ dist/core/db/migrations/

USER node

ENV NODE_ENV=production
ENV BACKEND_PORT=3051

EXPOSE 3051

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3051/api/health/ready').then(r=>{if(!r.ok)throw r.status;process.exit(0)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
