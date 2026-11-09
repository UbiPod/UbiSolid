# CSS 7.3 + css-invites (npm) + css-cloud-storage (this repo). Build from the repo root:
#   docker build -f deploy/css/Dockerfile -t ubisolid-css .
FROM oven/bun:1.3 AS plugin
WORKDIR /src
COPY packages/css-cloud-storage/package.json packages/css-cloud-storage/bun.lock packages/css-cloud-storage/tsconfig.json packages/css-cloud-storage/.componentsignore ./
RUN bun install --frozen-lockfile
COPY packages/css-cloud-storage/src ./src
COPY packages/css-cloud-storage/config ./config
COPY packages/css-cloud-storage/templates ./templates
RUN bun run build && bun pm pack --filename /css-cloud-storage.tgz

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY deploy/css/package.json ./
COPY --from=plugin /css-cloud-storage.tgz ./
RUN bun install --production

FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY deploy/css/package.json deploy/css/config.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV CSS_CONFIG=/app/config.json CSS_ROOT_FILE_PATH=/data CSS_PORT=3000
EXPOSE 3000
ENTRYPOINT ["node", "node_modules/@solid/community-server/bin/server.js", "-m", "/app"]
