#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/sandbox-build-helpers.sh"

IMAGE_NAME="openclaw-sandbox-browser:bookworm-slim"
docker_args=(build -t "${IMAGE_NAME}" -f Dockerfile.sandbox-browser)

append_sandbox_docker_build_args docker_args
docker_args+=(.)

docker "${docker_args[@]}"
echo "Built ${IMAGE_NAME}"
