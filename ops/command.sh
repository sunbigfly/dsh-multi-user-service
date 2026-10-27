#!/usr/bin/env bash
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
case "${1:-start}" in
  start|stop|restart|status) systemctl --user "${1:-start}" dsh-lan.service ;;
  logs) exec journalctl --user -u dsh-lan.service -n 30 --no-pager ;;
  *) echo 'Usage: dsh-lan [start|stop|restart|status|logs]' >&2; exit 2 ;;
esac
if [[ "${1:-start}" == start || "${1:-start}" == restart ]]; then
  echo "DSH LAN: http://${DSH_LAN_NAME:-$(hostname -s).local}:${DSH_LAN_PORT:-18620}/lan/"
fi
