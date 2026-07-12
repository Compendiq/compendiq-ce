FROM node:22-alpine AS builder
WORKDIR /build
COPY mcp-docs/package.json mcp-docs/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY mcp-docs/tsconfig.json mcp-docs/tsconfig.build.json ./
COPY mcp-docs/src/ src/
RUN npx tsc -p tsconfig.build.json

# Production dependencies only — no typescript/tsx/vitest/pino-pretty in runtime.
FROM node:22-alpine AS prod-deps
WORKDIR /build
COPY mcp-docs/package.json mcp-docs/package-lock.json* ./
RUN npm ci --ignore-scripts --omit=dev

FROM node:22-alpine
WORKDIR /app
# dumb-init as PID 1 reaps zombies and forwards SIGTERM to node for clean shutdown.
RUN apk add --no-cache dumb-init
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
# NODE_ENV=production also stops logger.ts from loading the pruned pino-pretty transport.
ENV NODE_ENV=production
COPY --from=builder /build/package.json ./
COPY --from=prod-deps /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
USER appuser
EXPOSE 3100
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
