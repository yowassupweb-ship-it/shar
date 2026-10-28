FROM node:22-alpine AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts eslint.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:stable-alpine

ENV SHAR_WEB_LISTEN=8080 \
    SHAR_API_UPSTREAM=api:8100

COPY docker/web.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=4 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
