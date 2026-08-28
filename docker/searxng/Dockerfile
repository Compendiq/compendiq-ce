FROM searxng/searxng:latest

COPY settings.yml.template /etc/searxng/settings.yml.template
COPY limiter.toml tracker-patterns-baseline.json tracker-patterns-baseline.LICENSE /usr/local/share/compendiq/
COPY generate-settings.sh render-limiter.py /usr/local/bin/
COPY patch-tracker-patterns.py /tmp/patch-tracker-patterns.py
RUN python3 /tmp/patch-tracker-patterns.py /usr/local/searxng/searx/data/tracker_patterns.py && \
    rm /tmp/patch-tracker-patterns.py && \
    chown searxng:searxng /etc/searxng/settings.yml.template \
      /usr/local/share/compendiq/limiter.toml \
      /usr/local/share/compendiq/tracker-patterns-baseline.json \
      /usr/local/share/compendiq/tracker-patterns-baseline.LICENSE && \
    chmod +x /usr/local/bin/generate-settings.sh /usr/local/bin/render-limiter.py

USER searxng

ENTRYPOINT ["/usr/local/bin/generate-settings.sh"]
