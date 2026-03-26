#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; source "$SCRIPT_DIR/nutshell.env"; set +a
exec "$SCRIPT_DIR/nutshell-venv/bin/mint"
