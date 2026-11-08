# Private Raspberry Pi deployment

Conclave can run on 64-bit Linux with a recent Node.js build containing SQLite FTS5. The deployed service uses Node 24 and listens only on `127.0.0.1:4777`; Cloudflare Tunnel provides the HTTPS connection. No router port forwarding is needed.

## Owner login

Set these environment variables before starting the server:

```ini
CONCLAVE_PUBLIC_ORIGIN=https://conclave.example.com
CONCLAVE_AUTH_FILE=/private/conclave/owner.json
CONCLAVE_INTERNAL_TOKEN=<random-local-service-token>
CONCLAVE_FILES_ROOT=/workspace/Conclave
AGENT_HUB_DATA_DIR=/private/conclave/data
```

The authentication file contains one username, a scrypt password hash and a session signing secret. Generate it with `createCredentials` exported by `src/auth.js`; it requires a password of at least 16 characters. Keep this file and environment configuration outside the repository with permissions `0600`. There is no registration endpoint.

Login protects pages, APIs, file operations and event streams. Browser sessions use HttpOnly, Secure and SameSite cookies on the public HTTPS origin. Signing out revokes the session; restarting the server requires signing in again. Mutating browser requests require the configured Origin. Local MCP requests must supply the internal token, use a loopback Host, and originate on loopback. Do not send that token to browsers.

The service should run as the regular owner account, start on boot and restart on failure. Keep the existing desktop server and any other Pi services separate. Configure the tunnel with the public hostname and service `http://127.0.0.1:4777`, followed by an `http_status:404` catch-all. Preserve the public Host header. Publish DNS only after confirming unauthenticated APIs return 401 and authenticated requests succeed.

Creating a named tunnel requires Account / Cloudflare Tunnel / Edit; publishing its DNS record requires Zone / DNS / Edit. A DNS-only token cannot create the connector. Cloudflare credentials and connector tokens belong outside the repository.

## File explorer

The Files page browses `CONCLAVE_FILES_ROOT` (default `~/Conclave`). It supports uploads up to 4 MB per file, folder creation, renaming, creating text files and editing UTF-8 text up to 512 KB. Saves reject stale versions rather than overwriting another edit. Traversal and symbolic links are rejected, and uploads do not overwrite existing files.

The rest of Conclave remains an owner administration tool with agent command execution and configuration access. The Files workspace boundary does not sandbox agents or other administrative APIs.

Agent CLIs and their account authentication are specific to the Pi's user account. Desktop installations and login sessions are not automatically transferred. Configure agents on the Pi before expecting remote council runs to work.

## Verification

Run `npm test` for login/session/origin/MCP checks and file boundary, upload, rename and edit-conflict checks alongside the existing suite. Run `node scripts/check-ui.mjs --isolated` for the existing responsive chat matrix. Never use private project files for public screenshots.
