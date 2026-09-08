# syntax=docker/dockerfile:1

# Node 24+ is required, not preferred: the store uses `node:sqlite`, which is
# built into the runtime rather than installed. That is why there is no database
# service to run alongside this container.
ARG NODE_VERSION=24-alpine

# ── deps ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The runner opens the database and starts trading on boot, so it must not run
# during a build step that has no keys and no volume.
ENV DISABLE_AGENTS=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4311
ENV HOSTNAME=0.0.0.0
# Written to a mounted volume, never into the image layer.
ENV DATABASE_PATH=/data/aioxy.db

# Unprivileged: this process holds agent private keys.
RUN addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nextjs -G nodejs \
 && mkdir -p /data && chown -R nextjs:nodejs /data

# `output: "standalone"` traces the runtime files; static and public are copied
# separately because the minimal server does not include them.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Next's file tracer follows the store's database path and copies `.data` into
# the standalone output — a real database, sealed agent keys included, inside
# the image. `.dockerignore` cannot prevent it because by then the file lives
# inside the output being copied, so it is removed explicitly here.
RUN rm -rf ./.data ./certificates

USER nextjs
EXPOSE 4311
VOLUME ["/data"]

# Checks that the RUNNER is ticking, not merely that the server answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4311)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
