#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
state="${DSH_LAN_STATE:-$HOME/.local/share/dsh-lan}"
mkdir -p "$state"
exec 9>"$state/server.lock"
flock -n 9 || { echo 'DSH LAN is already supervised.' >&2; exit 73; }
detect_ip() { ip -4 -o addr show scope global | awk '{split($4,a,"/"); if(a[1] ~ /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/) {print a[1]; exit}}'; }
lan="${DSH_LAN_HOST:-$(detect_ip)}"
[[ -n "$lan" ]] || { echo 'No LAN address is available.' >&2; exit 1; }
port="${DSH_LAN_PORT:-18620}"
name="${DSH_LAN_NAME:-$(hostname -s).local}"
node --input-type=module - "$lan" "$port" <<'JS'
import net from 'node:net';
for (const host of ['127.0.0.1', process.argv[2]]) {
  await new Promise((resolve,reject)=>{
    const probe=net.createServer(); probe.once('error',reject);
    probe.listen(Number(process.argv[3]),host,()=>probe.close(resolve));
  });
}
JS
node --input-type=module - "$state/member-origin.yml" "$lan" "$port" "$name" <<'JS'
import { writeFileSync } from 'node:fs';
const [file,host,port,name]=process.argv.slice(2);
const origin=`http://${host}:${port}`, alias=`http://${name}:${port}`;
new URL(origin); new URL(alias);
writeFileSync(file,`- id: multi-user-service\n  name: '@sunbigfly/dsh-multi-user-service'\n  config:\n    memberOrigin: ${JSON.stringify(origin)}\n    memberAliases: [${JSON.stringify(alias)}]\n    backupControlPath: ${JSON.stringify(file.replace(/member-origin\.yml$/, 'backup.sock'))}\n`,{mode:0o600});
JS
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
relay= hostpid= watchpid=
cleanup() { trap - EXIT TERM INT; for pid in "$watchpid" "$relay" "$hostpid"; do [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' TERM INT
node "$root/ops/relay.mjs" "$lan" "$port" &
relay=$!
dsh --profile lan --patch "$state/member-origin.yml" --no-open --host 127.0.0.1 --port "$port" "$@" &
hostpid=$!
if [[ -z "${DSH_LAN_HOST:-}" ]]; then
  (while sleep 10; do [[ "$(detect_ip)" == "$lan" ]] || exit 1; done) &
  watchpid=$!
fi
echo "Member entry: http://$name:$port/lan/ (IP: http://$lan:$port/lan/)"
wait -n "$relay" "$hostpid" ${watchpid:+"$watchpid"} || exit 1
exit 1
