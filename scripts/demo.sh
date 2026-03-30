#!/usr/bin/env bash
set -euo pipefail
API="${API_URL:-http://127.0.0.1:3000}"
TMP="${TMPDIR:-/tmp}/axion-demo-audio.bin"
printf '\x00\x01\x02' >"$TMP"

echo "POST voice note..."
RESP=$(curl -fsS -X POST "$API/experiences/voice" \
  -H "x-trace-id: demo-trace" \
  -F "file=@$TMP;type=audio/wav")
echo "$RESP" | python3 -m json.tool
DOC_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['documentId'])")

echo ""
echo "GET document $DOC_ID..."
curl -fsS "$API/documents/$DOC_ID" | python3 -m json.tool

echo ""
echo "POST /qa..."
curl -fsS -X POST "$API/qa" \
  -H 'content-type: application/json' \
  -d '{"question":"What did I say about Berlin?"}' | python3 -m json.tool

rm -f "$TMP"
echo ""
echo "Demo done."
