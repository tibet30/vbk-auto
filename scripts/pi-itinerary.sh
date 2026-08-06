#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
使用说明：
  ./scripts/pi-itinerary.sh <project_id> [cdp_port]

示例：
  VBK_CDP_PORT=9496 ./scripts/pi-itinerary.sh ff43aae4-3cbf-44c9-8712-c31f219eac46
  ./scripts/pi-itinerary.sh ff43aae4-3cbf-44c9-8712-c31f219eac46 9496
EOF
}

PROJECT_ID="${1:-}"
CDP_PORT="${2:-${VBK_CDP_PORT:-9539}}"

if [[ -z "$PROJECT_ID" ]]; then
  usage
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export VBK_CDP_PORT="$CDP_PORT"
node scripts/debug-step.mjs fillItineraryDraft --project "$PROJECT_ID"

