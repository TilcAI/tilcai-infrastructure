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
#   TILCAI_CORE_DIR    path to tilcai-core (default: ../tilcai-core, next to this repo)
#   RELAYER_SOURCE     where the relayer fork lives: a local clone or a git URL
#                      (default: https://github.com/SaulChoque/openzeppelin-relayer.git)
#   RELAYER_REF        commit, tag or branch of the fork to build (default: main)
#   RELAYER_FEATURES   cargo features of the relayer. `redis-tls-rustls` lets it talk to
#                      managed Redis over TLS (rediss://); set to "" to build without it
#   RELAYER_BASE       reuse an already built relayer base image instead of compiling it
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
core="${TILCAI_CORE_DIR:-$(dirname "$repo")/tilcai-core}"

REGISTRY="${REGISTRY:-tilcai}"
TAG="${TAG:-local}"
RELAYER_SOURCE="${RELAYER_SOURCE:-https://github.com/SaulChoque/openzeppelin-relayer.git}"
RELAYER_REF="${RELAYER_REF:-main}"
RELAYER_FEATURES="${RELAYER_FEATURES-redis-tls-rustls}"

what="${1:-all}"
built=()

build_tilcai() {
  [ -f "$core/src/contracts.ts" ] || {
    echo "tilcai-core not found at $core (set TILCAI_CORE_DIR)" >&2
    exit 1
  }
  # The app links tilcai-core as file:../tilcai-core, so the context needs both side by side.
  local ctx
  ctx="$(mktemp -d)"
  trap 'rm -rf "$ctx"' RETURN
  mkdir -p "$ctx/tilcai-core" "$ctx/tilcai-infrastructure/deploy"
  cp -r "$core/package.json" "$core/src" "$ctx/tilcai-core/"
  cp -r "$repo/package.json" "$repo/package-lock.json" "$repo/tsconfig.json" "$repo/src" \
    "$ctx/tilcai-infrastructure/"
  cp "$here/entrypoint.sh" "$ctx/tilcai-infrastructure/deploy/"
  docker build -f "$here/Dockerfile" -t "$REGISTRY/tilcai:$TAG" "$ctx"
  built+=("$REGISTRY/tilcai:$TAG")
}

build_relayer_base() {
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
