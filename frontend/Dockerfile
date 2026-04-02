# syntax=docker/dockerfile:1
# Draw.io stage — download and extract static webapp for self-hosted diagram editor
# alpine:3.23 is already a public multi-arch image; no change required.
FROM alpine:3.23 AS drawio
ARG DRAWIO_VERSION=29.6.4
RUN apk add --no-cache unzip wget
RUN wget -q "https://github.com/jgraph/drawio/releases/download/v${DRAWIO_VERSION}/draw.war" -O /tmp/draw.war
RUN \
    mkdir -p /drawio && \
    unzip -q /tmp/draw.war -d /drawio && \
    rm /tmp/draw.war

# Build stage — compile React app with Vite
# node:24-alpine is the public multi-arch (amd64 + arm64) floating tag.
FROM node:24-alpine AS builder

ARG VITE_API_URL=""

WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,target=/root/.npm npm ci -w frontend -w @compendiq/contracts
# Build @compendiq/contracts so frontend can resolve its type declarations
COPY packages/contracts/ ./packages/contracts/
RUN npm run build -w @compendiq/contracts
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.node.json ./frontend/
COPY frontend/public/ frontend/public/
COPY frontend/src/ frontend/src/
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w frontend

# Tools stage — grab wget for healthcheck
# nginx:alpine is the official multi-arch (amd64 + arm64) floating tag.
# The floating tag guarantees availability across platforms.
FROM nginx:alpine AS tools
RUN apk add --no-cache wget

# Runtime stage — nginx serves static files
# nginx:alpine is the public multi-arch floating tag.
# NOTE: The official nginx:alpine image uses ENTRYPOINT ["/docker-entrypoint.sh"]
# which expects "nginx" as the first CMD argument.  We override ENTRYPOINT to
# "nginx" directly so that CMD ["-g", "daemon off;"] is passed correctly,
# matching the behaviour of the previous DHI image which used ENTRYPOINT ["nginx"].
FROM nginx:alpine AS runtime

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
# Override the docker-entrypoint.sh from nginx:alpine so CMD ["-g", "daemon off;"]
# is passed directly to nginx (matching the DHI image behaviour).
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
