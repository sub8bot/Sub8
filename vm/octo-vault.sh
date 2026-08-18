#!/bin/bash
# Ask the host vault to list or paste a secret. Never prints the secret.
set -euo pipefail
cmd="${1:-}"

json_str() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

case "$cmd" in
  list)
    if [ -f /config/.sub8-vault-list.json ]; then
      cat /config/.sub8-vault-list.json
    else
      printf '%s\n' '{"accounts":[]}'
    fi
    ;;
  fill)
    id="${2:-}"
    field="${3:-password}"
    if [ -z "$id" ]; then
      echo '{"ok":false,"error":"usage: octo-vault fill <account-id> username|password"}'
      exit 1
    fi
    rm -f /tmp/sub8-vault-done.json
    printf '{"cmd":"fill","accountId":%s,"field":%s}\n' "$(json_str "$id")" "$(json_str "$field")" > /tmp/sub8-vault-req.json
    for _ in $(seq 1 50); do
      if [ -f /tmp/sub8-vault-done.json ]; then
        cat /tmp/sub8-vault-done.json
        rm -f /tmp/sub8-vault-done.json
        exit 0
      fi
      sleep 0.1
    done
    echo '{"ok":false,"error":"vault timed out"}'
    exit 1
    ;;
  *)
    echo 'usage: octo-vault list | octo-vault fill <account-id> username|password'
    exit 1
    ;;
esac
