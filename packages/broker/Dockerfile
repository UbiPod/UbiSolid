# UbiSolid token broker. Internal only: publish no ports, reach it over the compose network.
FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN rm -f src/*.test.ts && mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
ENV BROKER_DB=/data/broker.sqlite BROKER_PORT=8600
EXPOSE 8600
HEALTHCHECK --interval=30s --timeout=3s CMD ["bun", "-e", "fetch('http://127.0.0.1:8600/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "src/server.ts"]
