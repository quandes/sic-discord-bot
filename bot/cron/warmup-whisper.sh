#!/bin/sh
set -eu

ENV_FILE="${ENV_FILE:-/app/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${WHISPER_ASR_URL:?WHISPER_ASR_URL not set}"
: "${WHISPER_ASR_TOKEN:?WHISPER_ASR_TOKEN not set}"

echo "$(date -Iseconds) triggering whisper worker warmup"
curl -sS --max-time 900 -w '\nHTTP_STATUS:%{http_code}\n' -X POST \
  "${WHISPER_ASR_URL%/}/worker/start?initialize_service=whisper" \
  -H 'accept: application/json' \
  -H "Authorization: Bearer ${WHISPER_ASR_TOKEN}"
