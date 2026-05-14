FROM searxng/searxng:latest

COPY settings.yml.template /etc/searxng/settings.yml.template
COPY limiter.toml /etc/searxng/limiter.toml
COPY generate-settings.sh /usr/local/bin/generate-settings.sh
RUN chown searxng:searxng /etc/searxng/settings.yml.template /etc/searxng/limiter.toml && \
    chmod +x /usr/local/bin/generate-settings.sh

USER searxng

ENTRYPOINT ["/usr/local/bin/generate-settings.sh"]
