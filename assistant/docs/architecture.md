# Architecture and permissions

Jarvis is a separate repository, database, service account and dedicated Cloudflare Tunnel. Never modify Conclave. The owner explicitly authorized deployment/public DNS on 2026-11-08. Release 116ac13 runs as jarvis-api/jarvis-worker with a dedicated jarvis-tunnel service. Public origin: https://jarvis.aten-systems.site; LAN TLS: https://192.168.100.156:3443. The public origin binds loopback 3210. Node v24.18.0 was copied into /opt/jarvis/runtime/node without changing the global runtime. Conclave's process IDs/start times remained unchanged. Claude/Codex/agy/antigravity exist under /home/rasp-pi/.local/bin; service-account CLI authentication still needs explicit private setup.

PWA → HTTPS/tunnel → loopback Node API → SQLite WAL/private storage. Separate worker persists, materializes and atomically claims scheduled jobs. Supported runtime: Node >=24; deploy a maintained LTS ARM64 release. UTC epoch milliseconds for instants; IANA zones and original text remain on schedules.

## Data and security

Tables: owner, sessions, login_attempts, passkeys, challenges, conversations, messages, memories, schedules, consumed_previews, jobs, notifications, drafts, approvals, proposals, connections, oauth_states, secrets, cache, push_subscriptions, push_deliveries, devices, companions, companion_work, audit, settings.

Owner provisioned via interactive CLI; no public registration. Passwords use salted scrypt. Session credentials are keyed hashes with expiry and individual revocation. Cookies use Secure on HTTPS, HttpOnly and SameSite=Lax for OAuth return navigation. Exact Host checks throughout; exact Origin/JSON checks on browser writes. Companion endpoints use separate Bearer credentials. Persisted password throttling; passkeys require user verification, single-use challenges and counters.

Connector configuration and refresh tokens use AES-256-GCM. Independent encryption key stays outside SQLite. Credential setup never returns stored secrets. Provisioning credentials stay separate from runtime. Imported Markdown remains editable plain text, never HTML.

## Durable execution

Signed session-bound previews expire after five minutes and are consumed idempotently. Unique `(schedule_id, occurrence_at)` prevents duplicate occurrences. Atomic claims have renewable leases and attempt numbers. Safe jobs retry with bounded backoff. External actions become uncertain after ambiguous failures/expired leases and never blindly retry. Notification insertion/completion commit atomically. States: queued, running, waiting_for_approval, completed, failed, uncertain, cancelled.

Missed reminders skip or coalesce one latest occurrence. Edits/pauses cancel queued work. Running actions cannot be undone. Draft approval expires after 24 hours; approved external execution expires after 15 minutes. Individually authorized recurring exact-email occurrences also expire after 15 minutes. Google calendar IDs/Microsoft transaction IDs derive from job identity. Provider email acceptance is not delivery confirmation.

## Integrations

No application mock implementations or sample account data. Google/Microsoft use delegated authorization-code OAuth, state, PKCE, encrypted refresh storage/rotation and reconnect-required status. Read permission enables email/calendar reading. Prepare permission adds send/calendar write scopes, but external actions still require per-action approval. Recurring automatic email requires authorization of the exact immutable message on its individual schedule, with audit history.

OpenAI Responses and Anthropic Messages support bounded tool loops. Allowed tools read connected email/calendar/weather, prepare drafts and propose reminder schedules. Tools cannot send, directly create calendar events, run commands, grant permissions or silently write memory. Remote content is untrusted data. The server independently enforces approval and capabilities.

Claude Code and Codex adapters use fixed argv/no shell, limited environment inheritance, bounded subprocess output/time, private temporary workspaces and CLI tools/config integrations disabled. Verify installed versions and authentication under Jarvis's own service identity. Antigravity is detectable but cannot be selected until tool isolation is verified. GitHub CLI is detectable and is not itself a model provider. Do not copy Conclave credentials.

Open-Meteo current conditions/three-day forecasts cache for 15 minutes, with timestamps/CC BY 4.0 attribution. Setup confirms eligible personal noncommercial use. Terms verified at https://open-meteo.com/en/terms: free usage below 10,000 daily, 5,000 hourly and 600 minute calls. Briefings combine real account/calendar/weather data; rain reports show next-six-hour probability.

## Devices

Responsive PWA, shared server data, revocable browser sessions. No private API caching. Web Push uses per-session subscriptions, encrypted VAPID keys, known-service endpoint allowlists, generic lock-screen contents, stable notification tags and bounded retries. Persistent Inbox is the fallback; push may repeat after delivery ambiguity.

Optional outbound companions use unique hashed revocable credentials. Grants: notify, read_file, command. Work expires in five minutes; claim leases last one minute. Interrupted execution becomes uncertain with no replay. Files require realpath containment under local selected roots, size limits and interactive approval. Commands map local IDs to fixed argv arrays and require local interactive approval. Neither browsers nor models gain unrestricted OS control. Clipboard and phone OS control are absent.

## Validation and extension gates

Tests use synthetic local accounts/fixtures. Live ARM64 deployment validated owner login, Secure cookies, authenticated API/logout and one durable worker reminder. Public and LAN login/assets/health passed real-browser checks; all Jarvis units are enabled/active. Pi-hole and Unbound caches were cleared without service restarts to remove stale negative DNS. Live OAuth, real model/CLI use, provider token revocation, email/calendar acceptance and device push still need private account setup. No external provider account is linked and no external message was sent. Attachment upload, clipboard, voice and optional Conclave handoff remain extensions.
