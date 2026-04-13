FROM node:22-alpine AS builder
WORKDIR /build
COPY mcp-docs/package.json mcp-docs/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY mcp-docs/tsconfig.json mcp-docs/tsconfig.build.json ./
COPY mcp-docs/src/ src/
RUN npx tsc -p tsconfig.build.json

FROM node:22-alpine
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
COPY --from=builder /build/package.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
USER appuser
EXPOSE 3100
CMD ["node", "dist/index.js"]
