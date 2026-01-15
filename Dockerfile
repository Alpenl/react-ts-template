# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@10.26.0 --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
ARG BUILD_MODE=pro
RUN pnpm run build:${BUILD_MODE}

FROM nginx:1.27-alpine
ARG OUTPUT_DIR=dist-pro
COPY --from=builder /app/${OUTPUT_DIR} /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
