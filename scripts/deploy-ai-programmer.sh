#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="ai-programmer-sandbox:latest"

cd "$ROOT_DIR"

echo "[1/4] Building $IMAGE_TAG"
docker build -t "$IMAGE_TAG" -f extensions/ai-programmer/Dockerfile.sandbox .

echo "[2/4] Restarting gateway"
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-gateway.log 2>&1 &

echo "[3/4] Waiting for gateway"
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 http://127.0.0.1:18789/ >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS --max-time 5 http://127.0.0.1:18789/ >/dev/null

echo "[4/4] Verifying sandbox image"
docker run --rm "$IMAGE_TAG" sh -lc 'codex --version'

echo "ai-programmer deploy complete"
