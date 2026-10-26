FROM nginx:stable-alpine

ENV SHAR_WEB_LISTEN=8080 \
    SHAR_API_UPSTREAM=api:8100

COPY docker/web.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=4 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

