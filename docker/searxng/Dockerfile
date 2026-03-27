FROM searxng/searxng:latest

# Generate a random secret_key at build time and merge it into settings
COPY settings.yml /etc/searxng/settings.yml
RUN SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))") && \
    sed -i "s/limiter: false/secret_key: \"${SECRET}\"\n  limiter: false/" /etc/searxng/settings.yml
