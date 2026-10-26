FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    SHAR_V2_HOST=0.0.0.0 \
    SHAR_V2_PORT=8100 \
    SHAR_DATA_DIR=/app/data \
    SHAR_UPLOADS_DIR=/app/data/uploads

WORKDIR /app

COPY server/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && groupadd --gid 10001 shar \
    && useradd --uid 10001 --gid shar --no-create-home --shell /usr/sbin/nologin shar

COPY --chown=shar:shar server/app ./app
COPY --chown=shar:shar server/migrations ./migrations
RUN mkdir -p /app/data/uploads && chown -R shar:shar /app/data

USER shar

EXPOSE 8100

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=4 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/api/v2/health', timeout=4).read()"

CMD ["python", "-m", "app"]

