#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOCKDIR="$ROOT/.venv-creating"
for _ in $(seq 1 120); do
  if mkdir "$LOCKDIR" 2>/dev/null; then
    trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
    break
  fi
  sleep 0.2
done
if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  rm -rf "$ROOT/.venv"
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -U pip -q
fi
"$ROOT/.venv/bin/pip" install -e "$ROOT[dev]" -q
