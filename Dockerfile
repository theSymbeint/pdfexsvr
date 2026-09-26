# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# pdfexsvr - Hono PDF render service
#
# Cross-architecture note: this image is built for linux/amd64 from an Apple
# Silicon Mac by scripts/build-image.sh, using `docker buildx --platform` plus
# QEMU emulation. Nothing here depends on the build host's architecture: pnpm
# installs dependencies INSIDE the image for the *target* platform, and host
# node_modules / dist / .env are excluded by .dockerignore and never copied.
#
# DBURL / DBUSER / DBPASSWD are supplied as container env vars at run time
# (Coolify, `docker run -e`, compose). There is no .env in this image.
# ---------------------------------------------------------------------------

# ---------- build: all deps (typescript is a devDependency) + compile ----------
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# Dependencies first, so this layer caches across source-only changes.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# `pnpm build` = `tsc && cp -r public dist`
RUN pnpm build

# ---------- prod-deps: runtime dependencies only (no tsc/vitest/tsx) ----------
FROM node:22-alpine AS prod-deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# Non-root, keeping the uid/gid the original image used.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs hono

COPY --from=prod-deps --chown=hono:nodejs /app/node_modules ./node_modules
# dist/ = compiled JS; public/ is served at runtime by
# serveStatic({ root: "./public" }) with cwd=/app.
COPY --from=build     --chown=hono:nodejs /app/dist   ./dist
COPY --from=build     --chown=hono:nodejs /app/public ./public

ENV NODE_ENV=production
USER hono
EXPOSE 8080
CMD ["node", "dist/index.js"]
