# syntax=docker/dockerfile:1
# Draw.io stage — download and extract static webapp for self-hosted diagram editor
FROM dhi.io/alpine-base:3.23-alpine3.23-dev AS drawio
ARG DRAWIO_VERSION=29.6.4
RUN apk add --no-cache unzip wget
RUN wget -q "https://github.com/jgraph/drawio/releases/download/v${DRAWIO_VERSION}/draw.war" -O /tmp/draw.war
RUN \
    mkdir -p /drawio && \
    unzip -q /tmp/draw.war -d /drawio && \
    rm /tmp/draw.war

# Build stage — compile React app with Vite
FROM dhi.io/node:24-alpine3.23-dev AS builder

ARG VITE_API_URL=""

WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,target=/root/.npm npm ci -w frontend -w @atlasmind/contracts
# Build @atlasmind/contracts so frontend can resolve its type declarations
COPY packages/contracts/ ./packages/contracts/
RUN npm run build -w @atlasmind/contracts
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.node.json ./frontend/
COPY frontend/public/ frontend/public/
COPY frontend/src/ frontend/src/
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w frontend

# Tools stage — grab wget for healthcheck
FROM dhi.io/nginx:1.29-alpine3.23-dev AS tools
RUN apk add --no-cache wget

# Runtime stage — hardened nginx serves static files
FROM dhi.io/nginx:1.29-alpine3.23 AS runtime

# Copy wget + shared libraries needed on the minimal runtime image
COPY --from=tools /usr/bin/wget /usr/bin/wget
COPY --from=tools /usr/lib/libidn2* /usr/lib/
COPY --from=tools /usr/lib/libunistring* /usr/lib/

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY --from=drawio /drawio /usr/share/nginx/html/drawio
COPY frontend/nginx.conf /etc/nginx/nginx.conf
COPY frontend/nginx-security-headers.conf /etc/nginx/security-headers.conf
COPY frontend/nginx-cache-nocache.conf /etc/nginx/cache-nocache.conf
COPY frontend/nginx-cache-immutable.conf /etc/nginx/cache-immutable.conf
COPY frontend/nginx-cache-drawio.conf /etc/nginx/cache-drawio.conf

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/bin/wget", "--spider", "--quiet", "http://127.0.0.1:8081/"]

USER nginx
CMD ["-g", "daemon off;"]
