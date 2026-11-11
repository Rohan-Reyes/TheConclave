# Deployment, backup, restore and rollback

The owner explicitly authorized deployment/public DNS on 2026-11-08. Running release: 116ac13, /opt/jarvis/current. API/worker/tunnel units are enabled and active. Future upgrades still require owner authorization. Never change Conclave files, credentials, services, tunnel, ports or DNS.

Current configuration: isolated Node /opt/jarvis/runtime/node; public loopback origin 3210; LAN TLS 192.168.100.156:3443; encrypted app secrets in root-only /etc/jarvis/runtime.env; connector token in /etc/jarvis-tunnel/token; explicit /etc/jarvis-tunnel/config.yml prevents inheriting global cloudflared settings. Initial owner credential is /var/lib/jarvis/initial-owner-password, readable privately via sudo and removed when changed in Settings. CLI auth is not copied from other applications. LAN certificate expires after 365 days; renew it before expiry. Use public HTTPS for passkeys/OAuth.

## Deployment preparation

1. Private SSH authentication to rasp-pi@192.168.100.156 was verified read-only on 2026-11-08 using interactive password entry; key-only access failed. No passwords are stored in this repository. Use private credentials for future access.
2. Initial read-only inventory found ARM64, default Node v22.22.1, an nvm Node executable at /home/rasp-pi/.nvm/versions/node/v24.18.0/bin/node, and Claude/Codex/agy/antigravity executables in /home/rasp-pi/.local/bin. Verify versions, maintained LTS, service-user access, available resources, port 3210, cloudflared paths and CLI safety flags before deployment. Do not switch the global Node runtime or restart existing services.
3. Use /opt/jarvis/releases/<release-id> with a current symlink, dedicated jarvis and jarvis-tunnel users, /var/lib/jarvis as the Jarvis home, and /var/lib/jarvis/state for private state. Code should be read-only to runtime users. Install locked production dependencies in the new release.
4. Store private runtime environment at /etc/jarvis/runtime.env with root-only permissions: APP_ORIGIN=https://jarvis.aten-systems.site, APP_TIMEZONE=Asia/Manila, PORT=3210, DATA_DIR=/var/lib/jarvis/state, independent generated 64-hex-character SESSION_SECRET and TOKEN_ENCRYPTION_KEY. Exclude all Cloudflare provisioning credentials.
5. Provision the owner interactively under Jarvis's identity with the intended runtime environment. Setup loads .env if present; do not leave a development .env in production. Do not seed a demo owner.
6. Verify executable paths in the three dedicated unit templates. CLIs installed in rasp-pi's home may not be accessible to jarvis. Install binaries at suitable executable paths and authenticate deliberately as jarvis, never copy Conclave credentials. Auth lives in Jarvis's own home. Verify CLI safety flags; older incompatible versions fail closed. Antigravity invocation is disabled pending isolation verification.
7. Register exact HTTPS OAuth callbacks (/api/oauth/google/callback and/or /api/oauth/microsoft/callback). Owner-only consent/account settings and minimal scopes. Enter provider credentials through Connections. Run live consent/read/prepare/send/revocation and browser/device tests before relying on automations.

## Tunnel and publication — only after explicit approval

Create a dedicated Jarvis tunnel and connector credential. Scoped provisioning token: Account Cloudflare Tunnel Edit and Zone DNS Edit for the intended account/zone. Keep provisioning credentials separate from runtime. Store tunnel.json privately, readable by jarvis-tunnel and root; tunnel processes must not read runtime.env.

Use deploy/cloudflared.example.yml, exact hostname, loopback origin, correct Host header and final 404 rule. Validate using ingress validate/rule with the explicit config path. Create only the jarvis subdomain route. Never use global cloudflared service install if it could replace the Conclave service.

Install/enable/start only jarvis-api, jarvis-worker and jarvis-tunnel. Confirm loopback binding, health with Host: jarvis.aten-systems.site, HTTPS secure cookies, passkeys, persistence after restart, provider refresh and device revocation. Bypass Cloudflare caching for this app; responses already use no-store. Health alone is not production acceptance.

Cloudflare reference: https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/

## Backup

npm run backup (`src/backup.js`) opens the source SQLite database read-only (`new DatabaseSync(sourcePath, { readOnly: true })`) without running `openDb()` migrations and uses SQLite's online `backup()` API to write a consistent snapshot into `BACKUP_DIR` (defaults to `backups/`). Never copy just a live WAL main file, and always run `src/backup.js` before applying schema migrations. Hardened services cannot write release directories; run backups from a private writable working directory with correct `DATA_DIR` and `BACKUP_DIR`. Encrypt snapshots at rest/offsite; verify integrity and restore regularly. Back up `runtime.env`/encryption keys and Jarvis tunnel credentials separately in private encrypted storage. Losing the key loses connector access; DB plus key discloses encrypted credentials.

## Restore

1. Stop only Jarvis API/worker (and its tunnel if needed), leaving Conclave running.
2. Preserve current Jarvis state, including WAL/SHM, in a timestamped owner-only quarantine directory. Restore verified snapshot into a fresh state directory with matching key/ownership. Never pair an old WAL with restored main DB.
3. Run PRAGMA integrity_check. Delete restored sessions, OAuth states and passkey challenges. Revoke/re-enroll companion credentials if exposed.
4. A snapshot may predate successful external actions. Before starting the worker, mark restored queued/running external-action jobs uncertain, pause all schedules, cancel queued companion work, and mark running companion work uncertain. Reconcile against provider Sent folders/calendars; never replay backup actions blindly.
5. Start only Jarvis API, verify owner/memory/connections, reconcile jobs and authorize schedules again, then start Jarvis worker/tunnel. Confirm Conclave remains untouched.

## Upgrade/rollback

Record release target, service config and schema; take verified backup before an update. Build/test new release before switching symlink. Stop only Jarvis API/worker before backup, migration, and symlink switch. Keep old release and snapshot. Schema v2 adds additive columns on `memories` (`category`, `access_count`, `topic`, `last_accessed`, `source`, `metadata`) and table `memory_activity`.

Production cutover on the Raspberry Pi 5 awaits running the atomic upgrade script from an interactive SSH session (outside `conclave.service`'s `NoNewPrivileges=true` boundary). It defaults to `git rev-parse --short=7 HEAD` so no commit SHA argument is required:

```sh
sudo /home/rasp-pi/Conclave/2026-11-08-feb18d/jarvis/deploy/upgrade-pi.sh
```

Rollback: stop Jarvis API/worker, restore compatible prior code/config (`/opt/jarvis/releases/116ac13`). Restore DB only if necessary using the reconciliation process above; restoring can replay actions without it. Verify and start only Jarvis services. Never restore or overwrite Conclave.

## Coding agents (Claude Code, Codex, Antigravity)

Jarvis can use the CLIs logged in under the `rasp-pi` account as its chat model (Connections → Model → "… CLI · existing server login").
The `jarvis` service account cannot read those logins, so `jarvis-agents.service` runs as `rasp-pi` and exposes them on
`/run/jarvis-agents/bridge.sock` (mode 0660, group `jarvis`). `jarvis-api` reaches it through `AGENT_BRIDGE_SOCKET` in `/etc/jarvis/runtime.env`.

- Every CLI runs text-only in a throwaway directory: Claude with `--tools ''` and no MCP, Codex read-only with shell/apps/web disabled, Antigravity in `--sandbox` with a deny-all permission set. Prompts go through stdin, never argv.
- The bridge unit adds `ProtectSystem=strict`, `NoNewPrivileges` and hides `~/Conclave`, `~/.ssh`, `~/.cloudflared` and other secrets.
- One request at a time per agent (up to 4 queued). Usage counts against the owner's CLI plans.
- If an agent stops answering, log in again as `rasp-pi` (`claude`, `codex login`, `agy`) and `sudo systemctl restart jarvis-agents`.
