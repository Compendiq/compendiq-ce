FROM searxng/searxng:latest

COPY settings.yml.template /etc/searxng/settings.yml.template
COPY generate-settings.sh /usr/local/bin/generate-settings.sh
RUN chown searxng:searxng /etc/searxng/settings.yml.template && \
    chmod +x /usr/local/bin/generate-settings.sh

USER searxng

ENTRYPOINT ["/usr/local/bin/generate-settings.sh"]
