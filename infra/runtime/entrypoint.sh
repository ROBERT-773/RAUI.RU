#!/bin/sh
set -eu
role=${1:-api}
if [ "$#" -gt 0 ]; then shift; fi
case "$role" in
  api|web|migrate)
    if [ "$#" -ne 0 ]; then
      echo 'Unexpected runtime arguments' >&2
      exit 64
    fi
    ;;
  media|search|commerce|professional|trust)
    for argument in "$@"; do
      case "$role:$argument" in
        search:--once|search:--reindex|search:--reconcile|commerce:--once|professional:--once|trust:--once) ;;
        *) echo 'Unexpected runtime arguments' >&2; exit 64 ;;
      esac
    done
    ;;
  *) echo 'Unknown runtime role' >&2; exit 64 ;;
esac
root=${RAUI_RUNTIME_ROOT:-/app}
if [ "${SITE_URL:-}" != "$(cat "$root/site-origin")" ] || [ "${DEPLOYMENT_ENV:-}" != "$(cat "$root/deployment-env")" ]; then
  echo 'Runtime origin/environment must match the built artifact' >&2
  exit 64
fi
if [ "$role" = web ]; then
  cd "$root/apps/web"
  exec node node_modules/next/dist/bin/next start --hostname 127.0.0.1
fi
cd "$root/apps/api"
case "$role" in
  api) file=main ;;
  migrate) file=modules/database/migrate ;;
  media) file=worker ;;
  *) file=$role-worker ;;
esac
exec node "dist/$file.js" "$@"
