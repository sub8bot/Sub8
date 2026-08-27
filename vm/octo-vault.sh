#!/bin/bash
# Ask the host vault to list or paste a secret. Never prints the secret.
set -euo pipefail
cmd="${1:-}"

json_str() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

case "$cmd" in
  list)
    # Per display: teammates share this container, and a single shared file meant
    # every teammate read whichever bot's list was pushed last — the grant map
    # (ids, labels, sites, usernames), which is what you need to ask for a fill
    # under someone else's grants. The unsuffixed path is the fallback for a
    # host that predates this.
    n="$(printf '%s' "${DISPLAY:-}" | tr -cd '0-9')"
    mine="/config/.sub8-vault-list.${n}.json"
    if [ -n "$n" ] && [ -f "$mine" ]; then
      cat "$mine"
    elif [ -f /config/.sub8-vault-list.json ]; then
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
    # DISPLAY identifies WHICH bot is asking. Teammates share one container
    # (teams.addMember copies the chief's) but each gets its own X display, and
    # this request file is a single fixed path with no bot id in it — so the
    # host bridge used to authorise whichever bot its poll loop reached first,
    # letting an ungranted worker have an account filled under a teammate's
    # grants. `ts` lets the host drop a request nobody claims.
    printf '{"cmd":"fill","accountId":%s,"field":%s,"display":%s,"ts":%s}\n' \
      "$(json_str "$id")" "$(json_str "$field")" "$(json_str "${DISPLAY:-}")" "$(date +%s000)" \
      > /tmp/sub8-vault-req.json
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
