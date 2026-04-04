#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/coturn.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found." >&2
  echo "Create it from the example: cp $SCRIPT_DIR/coturn.env.example $ENV_FILE" >&2
  echo "Then set TURN_SHARED_SECRET to the output of: openssl rand -hex 32" >&2
  exit 1
fi

# Source the shared secret
# shellcheck source=/dev/null
source "$ENV_FILE"

if [[ -z "${TURN_SHARED_SECRET:-}" ]]; then
  echo "Error: TURN_SHARED_SECRET is not set in $ENV_FILE" >&2
  exit 1
fi

CONF_FILE="$SCRIPT_DIR/coturn.conf"

# Substitute the secret into the conf and run turnserver in the foreground
exec env TURN_SHARED_SECRET="$TURN_SHARED_SECRET" \
  turnserver \
    --static-auth-secret="$TURN_SHARED_SECRET" \
    --listening-port=3478 \
    --fingerprint \
    --lt-cred-mech \
    --use-auth-secret \
    --realm=satstreamr.local \
    --log-file=/var/log/coturn/coturn.log \
    --no-tls \
    --no-dtls \
    -v
