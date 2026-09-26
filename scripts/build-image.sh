#!/usr/bin/env bash
#
# Build the pdfexsvr container image for a target platform (default: linux/amd64)
# from ANY host architecture - including an Apple Silicon MacBook.
#
# How the cross-compile works: the Dockerfile's stages all run on multi-arch
# bases, and pnpm installs dependencies inside the build for the TARGET platform.
# `docker buildx --platform linux/amd64` pulls the amd64 bases and runs the build
# steps under QEMU emulation (bundled with Docker Desktop), so the result is a
# genuine amd64 image - not an arm64 one wearing an amd64 label. The host's
# node_modules/ and dist/ are excluded by .dockerignore and never copied.
#
# Usage:
#   scripts/build-image.sh                      # build eemergdev/pdfexsvr:latest for linux/amd64
#   scripts/build-image.sh --tag v1.2.0
#   scripts/build-image.sh --push               # also push to the registry (needs `docker login`)
#   scripts/build-image.sh --platform linux/arm64
#   scripts/build-image.sh --no-cache --no-verify
#
set -euo pipefail

IMAGE="${IMAGE:-eemergdev/pdfexsvr}"
TAG="latest"
PLATFORM="linux/amd64"
PUSH=0
NO_CACHE=0
VERIFY=1
EXTRA_TAGS=1
DOCKERFILE="Dockerfile"
SMOKE_PORT_RANGE=""

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --image)    IMAGE="$2"; shift 2 ;;
    --tag)      TAG="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --push)     PUSH=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --no-extra-tags) EXTRA_TAGS=0; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die()  { printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
info() { printf '\033[36m----\033[0m  %s\n' "$*"; }

TARGET_OS="${PLATFORM%%/*}"
TARGET_ARCH="${PLATFORM##*/}"
case "$TARGET_ARCH" in
  amd64) TARGET_UNAME="x86_64" ;;
  arm64) TARGET_UNAME="aarch64" ;;
  *)     TARGET_UNAME="" ;;
esac

# --------------------------------------------------------------------------
info "preflight"
# --------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker CLI not found"
docker info >/dev/null 2>&1 || die "docker daemon not reachable (is Docker Desktop running?)"
docker buildx version >/dev/null 2>&1 || die "docker buildx missing (Docker Desktop >= 2 ships it)"
ok "docker + buildx available"

# The single most important check: .dockerignore must exist and must exclude .env,
# or COPY . . bakes the live DB credentials into an image that gets published.
[ -f .dockerignore ] || die ".dockerignore is MISSING - refusing to build (would copy .env into the image)"
grep -qE '^\.env$' .dockerignore || die ".dockerignore does not exclude '.env' - refusing to build"
ok ".dockerignore present and excludes .env"

if [ -f .env ]; then
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    die ".env is TRACKED BY GIT - remove it from the index before building"
  fi
  ok ".env exists locally (will be excluded) and is not tracked by git"
fi

[ -f "$DOCKERFILE" ] || die "$DOCKERFILE not found"

HOST_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)"
if [ -n "$TARGET_UNAME" ] && [ "$TARGET_ARCH" != "${HOST_ARCH/aarch64/arm64}" ]; then
  info "cross-building $PLATFORM on $HOST_ARCH - verifying QEMU emulation"
  if emu_out="$(docker run --rm --platform "$PLATFORM" alpine uname -m 2>&1)"; then
    [ "$emu_out" = "$TARGET_UNAME" ] || die "emulation check returned '$emu_out', expected '$TARGET_UNAME'"
    ok "emulation works ($PLATFORM runs under QEMU -> $emu_out)"
  else
    die "cannot run $PLATFORM containers. In Docker Desktop: Settings > General > 'Use Rosetta'/emulation, or install qemu via 'docker run --privileged --rm tonistiigi/binfmt --install amd64'"
  fi
else
  ok "native build ($HOST_ARCH) - no emulation needed"
fi

# --------------------------------------------------------------------------
info "tags"
# --------------------------------------------------------------------------
TAGS=("${IMAGE}:${TAG}")
if [ "$EXTRA_TAGS" = 1 ] && git rev-parse --git-dir >/dev/null 2>&1; then
  SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
  DIRTY=""
  [ -n "$(git status --porcelain 2>/dev/null)" ] && DIRTY="-dirty"
  [ -n "$SHA" ] && TAGS+=("${IMAGE}:sha-${SHA}${DIRTY}")
fi
for t in "${TAGS[@]}"; do ok "$t"; done

# --------------------------------------------------------------------------
info "building $PLATFORM  (first run under QEMU is slow; deps are cached afterwards)"
# --------------------------------------------------------------------------
BUILD_ARGS=(--platform "$PLATFORM" --file "$DOCKERFILE")
for t in "${TAGS[@]}"; do BUILD_ARGS+=(--tag "$t"); done
[ "$NO_CACHE" = 1 ] && BUILD_ARGS+=(--no-cache)
if [ "$PUSH" = 1 ]; then
  BUILD_ARGS+=(--push)
  ok "will push after building"
else
  BUILD_ARGS+=(--load)
fi

docker buildx build "${BUILD_ARGS[@]}" .

# --------------------------------------------------------------------------
info "verify"
# --------------------------------------------------------------------------
if [ "$PUSH" = 1 ]; then
  info "pushed; skipping local verification (image was not loaded locally)"
  printf '\n\033[32mPUSHED\033[0m %s\n' "${TAGS[*]}"
  exit 0
fi

ARCH_OUT="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "${IMAGE}:${TAG}")"
[ "$ARCH_OUT" = "$TARGET_OS/$TARGET_ARCH" ] || die "image platform is '$ARCH_OUT', expected '$TARGET_OS/$TARGET_ARCH'"
ok "image platform is $ARCH_OUT"

SIZE="$(docker image inspect --format '{{.Size}}' "${IMAGE}:${TAG}" | awk '{printf "%.1f MB", $1/1000000}')"
ok "image size $SIZE"

# No secrets, no host artifacts, no devDependencies in the runtime layer.
docker run --rm --platform "$PLATFORM" --entrypoint sh "${IMAGE}:${TAG}" -c '
  set -e
  [ ! -e /app/.env ]            || { echo "SECRET LEAK: /app/.env exists"; exit 1; }
  [ ! -e /app/.env.example ]    || echo "warn: /app/.env.example present"
  [ ! -e /app/src ]             || { echo "source tree baked in"; exit 1; }
  [ ! -e /app/node_modules/typescript ] || { echo "devDependencies present"; exit 1; }
  [ -e /app/dist/index.js ]     || { echo "dist/index.js missing"; exit 1; }
  [ -e /app/public ]            || { echo "public/ missing"; exit 1; }
  [ -e /app/node_modules/hono ] || { echo "runtime deps missing"; exit 1; }
  echo "layout clean: no .env, no src/, no devDeps; dist + public + prod node_modules present"
'
ok "image contents clean (no secrets, no host artifacts, no devDependencies)"

if [ "$VERIFY" = 0 ]; then
  printf '\n\033[32mBUILT\033[0m %s  (%s)\n' "${IMAGE}:${TAG}" "$ARCH_OUT"
  exit 0
fi

# --------------------------------------------------------------------------
info "smoke test: boot the amd64 image and hit the real routes"
# --------------------------------------------------------------------------
SMOKE_CIDS=()
cleanup() { for c in "${SMOKE_CIDS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

boot() { # boot <label> [docker run args...] -> sets PORT
  local label="$1"; shift
  local cid
  cid="$(docker run -d --platform "$PLATFORM" -p 127.0.0.1::8080 "$@" "${IMAGE}:${TAG}")"
  SMOKE_CIDS+=("$cid")
  PORT="$(docker port "$cid" 8080 | head -1 | sed 's/.*://')"
  local i
  for i in $(seq 1 90); do
    if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/healthcheck" 2>/dev/null; then
      ok "$label: container up on 127.0.0.1:${PORT}"
      return 0
    fi
    sleep 0.5
  done
  echo "--- container logs ($label) ---" >&2
  docker logs "$cid" >&2 || true
  die "$label: container never became ready"
}

# 1) With credentials present: the service must answer normally.
boot "with creds" -e DBURL=http://127.0.0.1:1/ -e DBUSER=smoke@example.com -e DBPASSWD=smoke-not-real
HC="$(curl -fsS -m 10 "http://127.0.0.1:${PORT}/healthcheck" || true)"
[ "$HC" = "OK!!" ] || die "healthcheck returned '$HC', expected 'OK!!'"
ok "GET /healthcheck -> 200 '$HC'"
TE="$(curl -s -m 10 -w '|%{http_code}' "http://127.0.0.1:${PORT}/test")"
[ "$TE" = "Hello World!|200" ] || die "GET /test returned '$TE', expected 'Hello World!|200'"
ok "GET /test -> 200 'Hello World!' (env vars passed through to the process)"

# 2) Without credentials: the guard must fire, proving env vars are not baked in.
boot "no creds"
GUARD="$(curl -s -m 10 -w '|%{http_code}' "http://127.0.0.1:${PORT}/test")"
case "$GUARD" in
  "DATABASE CREDENTIALS NOT SET|500") ok "GET /test with no creds -> 500 'DATABASE CREDENTIALS NOT SET' (nothing baked in)" ;;
  *) die "expected the credentials guard, got '$GUARD'" ;;
esac

printf '\n\033[32mBUILT + VERIFIED\033[0m  %s  (%s, %s)\n' "${IMAGE}:${TAG}" "$ARCH_OUT" "$SIZE"
printf 'run it:  docker run --rm -p 8080:8080 -e DBURL=... -e DBUSER=... -e DBPASSWD=... %s\n' "${IMAGE}:${TAG}"
[ "$PUSH" = 0 ] && printf 'publish: %s --push\n' "${BASH_SOURCE[0]}"
printf '\n'
