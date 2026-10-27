#!/bin/sh
set -eu
exec node "$(dirname "$0")/../runtime/assistant-runtime.mjs" "$@"
