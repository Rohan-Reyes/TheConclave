#!/usr/bin/env bash
# First installation only. Owner explicitly authorized Jarvis deployment.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run this installer with sudo.'; exit 1; }
release_id="${1:?release id required}"
[[ "$release_id" =~ ^[a-f0-9]{7,40}$ ]] || exit 1
staging=/home/rasp-pi/.jarvis-provisioning
root=/opt/jarvis
release="$root/releases/$release_id"
test ! -e "$root/current" || { echo 'Jarvis already installed; use the upgrade procedure.'; exit 1; }
for unit in jarvis-api jarvis-worker jarvis-tunnel; do
  test ! -e "/etc/systemd/system/$unit.service" || { echo "Existing $unit unit; refusing overwrite."; exit 1; }
done
for port in 3210 3443; do
  if ss -H -ltn "sport = :$port" | read -r _; then echo "Port $port is occupied; refusing installation."; exit 1; fi
done
id jarvis >/dev/null 2>&1 || useradd --system --home-dir /var/lib/jarvis --shell /usr/sbin/nologin jarvis
id jarvis-tunnel >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin jarvis-tunnel
install -d -m 0755 "$root" "$root/releases" "$root/runtime" "$release"
install -m 0755 /home/rasp-pi/.nvm/versions/node/v24.18.0/bin/node "$root/runtime/node"
tar -xzf "$staging/jarvis-release.tar.gz" -C "$release"
cd "$release"
PATH="$root/runtime:/usr/local/bin:/usr/bin:/bin" "$root/runtime/node" /home/rasp-pi/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts
install -d -o jarvis -g jarvis -m 0700 /var/lib/jarvis /var/lib/jarvis/state
install -d -o root -g jarvis -m 0750 /etc/jarvis
install -d -o root -g jarvis-tunnel -m 0750 /etc/jarvis-tunnel
test ! -e /etc/jarvis/runtime.env || { echo 'Existing runtime environment; refusing replacement.'; exit 1; }
"$root/runtime/node" --input-type=module <<'NODE'
import {writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
writeFileSync('/etc/jarvis/runtime.env',`APP_ORIGIN=https://jarvis.aten-systems.site\nAPP_TIMEZONE=Asia/Manila\nPORT=3210\nDATA_DIR=/var/lib/jarvis/state\nHOME=/var/lib/jarvis\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nTOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nWEATHER_PROVIDER=open-meteo\nLAN_ORIGIN=https://192.168.100.156:3443\nLAN_TLS_KEY=/etc/jarvis/lan-key.pem\nLAN_TLS_CERT=/etc/jarvis/lan-cert.pem\nINITIAL_OWNER_PASSWORD_FILE=/var/lib/jarvis/initial-owner-password\n`,{mode:0o600,flag:'wx'});
NODE
openssl req -x509 -nodes -newkey rsa:2048 -days 365 -subj '/CN=Jarvis LAN' -addext 'subjectAltName=IP:192.168.100.156,DNS:jarvis.local' -addext 'basicConstraints=critical,CA:FALSE' -addext 'extendedKeyUsage=serverAuth' -keyout /etc/jarvis/lan-key.pem -out /etc/jarvis/lan-cert.pem 2>/dev/null
chown root:jarvis /etc/jarvis/lan-key.pem /etc/jarvis/lan-cert.pem
chmod 0640 /etc/jarvis/lan-key.pem /etc/jarvis/lan-cert.pem
install -o root -g jarvis-tunnel -m 0640 "$staging/tunnel-token" /etc/jarvis-tunnel/token
printf 'loglevel: info\n' > /etc/jarvis-tunnel/config.yml
chown root:jarvis-tunnel /etc/jarvis-tunnel/config.yml
chmod 0640 /etc/jarvis-tunnel/config.yml
set -a
source /etc/jarvis/runtime.env
set +a
runuser -u jarvis -- "$root/runtime/node" "$release/deploy/bootstrap-owner.mjs"
ln -s "$release" "$root/current"
for unit in jarvis-api jarvis-worker; do
  sed 's|ExecStart=/usr/bin/node |ExecStart=/opt/jarvis/runtime/node |;s|Environment=PATH=.*|Environment=PATH=/opt/jarvis/runtime:/usr/local/bin:/usr/bin:/bin|' "$release/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
done
cat > /etc/systemd/system/jarvis-tunnel.service <<'UNIT'
[Unit]
Description=Jarvis dedicated Cloudflare Tunnel
After=network-online.target jarvis-api.service
Wants=network-online.target
[Service]
Type=simple
User=jarvis-tunnel
Group=jarvis-tunnel
ExecStart=/usr/local/bin/cloudflared tunnel --config /etc/jarvis-tunnel/config.yml --no-autoupdate --metrics 127.0.0.1:20243 run --token-file /etc/jarvis-tunnel/token
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
UNIT
systemd-analyze verify /etc/systemd/system/jarvis-api.service /etc/systemd/system/jarvis-worker.service /etc/systemd/system/jarvis-tunnel.service
systemctl daemon-reload
systemctl enable --now jarvis-api.service jarvis-worker.service jarvis-tunnel.service
systemctl is-active jarvis-api.service jarvis-worker.service jarvis-tunnel.service
echo 'Jarvis installed. Initial owner: owner. Retrieve password privately with sudo cat /var/lib/jarvis/initial-owner-password'
echo 'Change it in Settings after login; changing the password removes the initial credential file.'
