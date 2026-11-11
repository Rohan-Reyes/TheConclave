#!/usr/bin/env bash
# Atomic upgrade and private dossier import for Jarvis on the Raspberry Pi 5.
# Preserves Conclave services, stages tracked Git files via git archive while services run,
# stops jarvis-api and jarvis-worker before taking a pre-migration online SQLite backup and importing only the two owner dossiers,
# atomically switches /opt/jarvis/current with automatic rollback on failure, and restarts jarvis-api and jarvis-worker.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run this upgrader with sudo from an interactive SSH shell (outside conclave.service NoNewPrivileges).'; exit 1; }

workspace="/home/rasp-pi/Conclave/2026-11-08-feb18d"
repo="$workspace/jarvis"
root="/opt/jarvis"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$repo"
release_id="${1:-$(git -C "$repo" rev-parse --short=7 HEAD)}"
[[ "$release_id" =~ ^[a-f0-9]{7,40}$ ]] || { echo "Invalid release_id: $release_id"; exit 1; }
release="$root/releases/$release_id"
prev_release="$(readlink -f "$root/current" || true)"
if [[ -e "$release" ]]; then
  echo "Release directory already exists: $release (refusing to overwrite active or existing release)." >&2
  exit 1
fi

conclave_before="$(systemctl show conclave.service cloudflared-conclave.service -p Id,MainPID,ActiveState,ExecMainStartTimestamp)"
stage_dir=""
tmp_dir=""
backup_file=""
services_stopped=0
db_mutated=0
symlink_switched=0

cleanup_and_rollback() {
  local code=$?
  if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
    rm -rf "$stage_dir"
  fi
  if [[ -n "$tmp_dir" && -d "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
  if (( code != 0 )) && (( services_stopped == 1 || db_mutated == 1 || symlink_switched == 1 )); then
    echo "ERROR: Upgrade failed (exit $code). Rolling back code and database state..." >&2
    systemctl stop jarvis-api.service jarvis-worker.service || true
    if [[ -n "$prev_release" && -d "$prev_release" ]]; then
      ln -sfn "$prev_release" "$root/current.rollback"
      mv -Tf "$root/current.rollback" "$root/current"
    fi
    if (( db_mutated == 1 )) && [[ -n "$backup_file" && -f "$backup_file" ]]; then
      rm -f /var/lib/jarvis/state/jarvis.sqlite-wal /var/lib/jarvis/state/jarvis.sqlite-shm
      install -o jarvis -g jarvis -m 0600 "$backup_file" /var/lib/jarvis/state/jarvis.sqlite
    fi
    systemctl restart jarvis-agents.service 2>/dev/null || true
    systemctl start jarvis-api.service jarvis-worker.service || true
  fi
  exit "$code"
}
trap cleanup_and_rollback EXIT

echo "1. Staging release $release_id into $release (tracked Git files only)..."
install -d -m 0755 "$root/releases"
stage_dir="$(mktemp -d "$root/releases/.stage-${release_id}.XXXXXX")"
chmod 0755 "$stage_dir"
git -C "$repo" archive HEAD | tar -C "$stage_dir" -xf -
cd "$stage_dir"
umask 022
PATH="$root/runtime:/usr/local/bin:/usr/bin:/bin" "$root/runtime/node" /home/rasp-pi/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts
chmod -R a+rX "$stage_dir"
PATH="$root/runtime:/usr/local/bin:/usr/bin:/bin" "$root/runtime/node" /home/rasp-pi/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js test
mv -T "$stage_dir" "$release"
stage_dir=""
cd "$release"

echo "2. Stopping jarvis-api.service and jarvis-worker.service before backup and migration..."
services_stopped=1
systemctl stop jarvis-api.service jarvis-worker.service

echo "3. Taking pre-migration online SQLite backup of /var/lib/jarvis/state/jarvis.sqlite..."
install -d -o jarvis -g jarvis -m 0700 /var/lib/jarvis/backups
backup_out="$(runuser -u jarvis -- env DATA_DIR=/var/lib/jarvis/state BACKUP_DIR=/var/lib/jarvis/backups "$root/runtime/node" "$release/src/backup.js")"
echo "$backup_out"
backup_file="$(printf '%s\n' "$backup_out" | sed -n 's/^Consistent database backup: //p' | head -n 1)"
test -n "$backup_file" && test -f "$backup_file"

echo "4. Running schema migration and importing owner dossiers into /var/lib/jarvis/state/jarvis.sqlite..."
dossier_a="$workspace/.conclave/attachments/8b5a0642-07dd-4158-a3b9-9e9d53ba2117-comprehensive_project_profile_context.txt.txt"
dossier_b="$workspace/.conclave/attachments/6c296960-9b83-4b8a-a1fa-a9eba9b969e5-complete_strategic_context_master_dossier.txt.txt"
tmp_dir="$(mktemp -d /tmp/jarvis-dossiers.XXXXXX)"
chmod 0700 "$tmp_dir"
chown jarvis:jarvis "$tmp_dir"
install -o jarvis -g jarvis -m 0600 "$dossier_a" "$tmp_dir/comprehensive_project_profile_context.txt"
install -o jarvis -g jarvis -m 0600 "$dossier_b" "$tmp_dir/complete_strategic_context_master_dossier.txt"
db_mutated=1
runuser -u jarvis -- env DATA_DIR=/var/lib/jarvis/state "$root/runtime/node" "$release/scripts/import-memories.mjs" \
  "$tmp_dir/comprehensive_project_profile_context.txt" \
  "$tmp_dir/complete_strategic_context_master_dossier.txt"
rm -rf "$tmp_dir"
tmp_dir=""

echo "5. Atomically switching /opt/jarvis/current to $release and starting jarvis-api and jarvis-worker..."
ln -sfn "$release" "$root/current.new"
mv -Tf "$root/current.new" "$root/current"
symlink_switched=1

echo "Installing the agent bridge (Claude Code, Codex, Antigravity CLIs, text-only)..."
install -m 0644 "$release/deploy/jarvis-agents.service" /etc/systemd/system/jarvis-agents.service
grep -q '^AGENT_BRIDGE_SOCKET=' /etc/jarvis/runtime.env || echo 'AGENT_BRIDGE_SOCKET=/run/jarvis-agents/bridge.sock' >> /etc/jarvis/runtime.env
systemctl daemon-reload
systemctl enable jarvis-agents.service >/dev/null
systemctl restart jarvis-agents.service
for i in {1..20}; do test -S /run/jarvis-agents/bridge.sock && break; sleep 0.5; done
test -S /run/jarvis-agents/bridge.sock || { echo "ERROR: agent bridge socket did not appear" >&2; exit 1; }

systemctl restart jarvis-api.service jarvis-worker.service
systemctl is-active jarvis-api.service jarvis-worker.service jarvis-tunnel.service

echo "Waiting for jarvis-api to listen on 127.0.0.1:3210..."
ready=0
for i in {1..30}; do
  if curl -s -o /dev/null --max-time 1 -H "Host: jarvis.aten-systems.site" http://127.0.0.1:3210/api/health; then
    ready=1
    break
  fi
  sleep 0.5
done
if (( ready != 1 )); then
  echo "ERROR: jarvis-api failed to start listening on port 3210 within 15s" >&2
  exit 1
fi

echo "6. Running post-deployment verification..."
set -a
source /etc/jarvis/runtime.env
set +a
runuser -u jarvis -- env DATA_DIR=/var/lib/jarvis/state "$root/runtime/node" "$release/scripts/deployment-check.mjs"
curl -fsS --max-time 10 -H "Host: jarvis.aten-systems.site" http://127.0.0.1:3210/dashboard.js >/dev/null
echo "Agent bridge inventory (as the jarvis service account):"
runuser -u jarvis -- curl -fsS --max-time 60 --unix-socket /run/jarvis-agents/bridge.sock http://bridge/agents
echo

conclave_after="$(systemctl show conclave.service cloudflared-conclave.service -p Id,MainPID,ActiveState,ExecMainStartTimestamp)"
test "$conclave_before" = "$conclave_after" || { echo "WARNING: Conclave service state changed!"; exit 1; }
echo "Conclave PIDs and start times verified unchanged."

services_stopped=0
db_mutated=0
symlink_switched=0
echo "Upgrade to $release_id complete."
