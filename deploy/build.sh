#!/usr/bin/env bash
# Builds the three images of the TilcAI stack.
#
#   ./deploy/build.sh                 # build everything, tagged :local
#   ./deploy/build.sh tilcai          # only TilcAI
#   ./deploy/build.sh relayer         # only the relayer (base + TilcAI config)
#
#   REGISTRY=us-central1-docker.pkg.dev/my-project/tilcai TAG=$(git rev-parse --short HEAD) \
#     PUSH=1 ./deploy/build.sh        # tag for a registry and push
#
# Variables
#   REGISTRY           image prefix (default: tilcai, i.e. local only)
#   TAG                image tag (default: local)
#   PUSH               1 = docker push after building
#   NPMRC_FILE         authenticated npmrc file for BuildKit (required for API)
#   RELAYER_SOURCE     where the relayer fork lives: a local clone or a git URL
#                      (default: https://github.com/SaulChoque/openzeppelin-relayer.git)
#   RELAYER_REF        immutable 40-hex commit of the fork (required when building the relayer)
#   RELAYER_FEATURES   cargo features of the relayer. `redis-tls-rustls` lets it talk to
#                      managed Redis over TLS (rediss://); set to "" to build without it
#   RELAYER_BASE       reuse an already built relayer base image instead of compiling it
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

REGISTRY="${REGISTRY:-tilcai}"
TAG="${TAG:-local}"
RELAYER_SOURCE="${RELAYER_SOURCE:-https://github.com/SaulChoque/openzeppelin-relayer.git}"
RELAYER_REF="${RELAYER_REF:-}"
RELAYER_FEATURES="${RELAYER_FEATURES-redis-tls-rustls}"

what="${1:-all}"
built=()
ctx=""
trap '[ -z "$ctx" ] || rm -rf "$ctx"' EXIT

build_tilcai() {
  [ -f "${NPMRC_FILE:-}" ] || { echo 'Set NPMRC_FILE to an authenticated npmrc file' >&2; exit 1; }
  ctx="$(mktemp -d)"
  mkdir -p "$ctx/tilcai-infrastructure/deploy"
  cp -r "$repo/package.json" "$repo/package-lock.json" "$repo/tsconfig.json" "$repo/src" \
    "$ctx/tilcai-infrastructure/"
  cp "$here/entrypoint.sh" "$ctx/tilcai-infrastructure/deploy/"
  docker build --secret "id=npmrc,src=$NPMRC_FILE" -f "$here/Dockerfile" -t "$REGISTRY/tilcai:$TAG" "$ctx"
  built+=("$REGISTRY/tilcai:$TAG")
}

build_relayer_base() {
  [[ "$RELAYER_REF" =~ ^[0-9a-f]{40}$ ]] || {
    echo "RELAYER_REF must be an immutable 40-hex commit; branches such as main are forbidden" >&2
    exit 64
  }
  local image="$REGISTRY/oz-relayer-base:$TAG"
  if [ -d "$RELAYER_SOURCE/.git" ]; then
    # Local clone: send only tracked files, so a local config/ (keystore, .env) never
    # reaches the build context.
    git -C "$RELAYER_SOURCE" archive --format=tar "$RELAYER_REF" |
      docker build -f Dockerfile.production \
        --build-arg "CARGO_FEATURES=$RELAYER_FEATURES" -t "$image" -
  else
    docker build -f Dockerfile.production \
      --build-arg "CARGO_FEATURES=$RELAYER_FEATURES" -t "$image" \
      "$RELAYER_SOURCE#$RELAYER_REF"
  fi
  RELAYER_BASE="$image"
}

build_relayer() {
  [ -n "${RELAYER_BASE:-}" ] || build_relayer_base
  docker build --build-arg "RELAYER_BASE=$RELAYER_BASE" \
    -t "$REGISTRY/relayer:$TAG" "$here/relayer"
  built+=("$REGISTRY/relayer:$TAG")
}

case "$what" in
  all) build_tilcai && build_relayer ;;
  tilcai) build_tilcai ;;
  relayer) build_relayer ;;
  *)
    echo "usage: $0 [all|tilcai|relayer]" >&2
    exit 64
    ;;
esac

if [ "${PUSH:-0}" = "1" ]; then
  for image in "${built[@]}"; do docker push "$image"; done
fi
printf 'built: %s\n' "${built[@]}"
