# syntax=docker/dockerfile:1
FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Optional registry mirror, e.g. `--build-arg NPM_CONFIG_REGISTRY=https://mirror.example/npm/`.
ARG NPM_CONFIG_REGISTRY
COPY package.json bun.lock ./
# bun.lock pins tarball URLs of whichever registry created it; resolve against the configured one instead
# (integrity hashes are still verified).
RUN --mount=type=cache,target=/root/.bun/install/cache \
  sed -i -E 's#"https?://[^"]+\.tgz"#""#g' bun.lock \
  && bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json prisma.config.ts ./
COPY prisma prisma
COPY src src
RUN bunx --bun prisma generate && bun run build

# The bundle is self-contained (Prisma's query compiler is inlined), so no node_modules at runtime.
FROM oven/bun:1.4-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
ENV NODE_ENV=production \
  DATABASE_URL=file:/app/data/fsre-sync-backend.db
COPY --from=build /app/dist dist
COPY prisma/migrations prisma/migrations
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && mkdir data && chown bun:bun data
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO /dev/null http://127.0.0.1:5000/api/health || exit 1
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["bun", "dist/index.js"]
