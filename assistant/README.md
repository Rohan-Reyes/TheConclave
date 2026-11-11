# JARVIS

Private single-owner assistant, separate from Conclave. Deployed with the owner's explicit authorization on 2026-11-08.

## Deployed addresses

- Public: https://jarvis.aten-systems.site
- LAN: https://192.168.100.156:3443 (locally generated TLS certificate; trust it or expect a certificate warning)
- System services: jarvis-api, jarvis-worker, jarvis-tunnel; running application release: 116ac13.

Initial username: `owner`. Retrieve the generated password privately using `ssh -t rasp-pi@192.168.100.156 "sudo cat /var/lib/jarvis/initial-owner-password"`. Change it in Settings; this removes the initial password file. No login password or Cloudflare token is committed. Use the public HTTPS address for passkeys and OAuth setup. Connect model/apps in Connections; external provider accounts are not automatically linked.

## Run locally

Use Node >=24 (maintained LTS preferred).

```powershell
cd jarvis
npm ci
npm run setup
npm start
```

Run `npm run worker` in another terminal in the same directory. Open http://localhost:3210 (passkeys require a domain name, including localhost). Setup generates independent secrets in ignored `.env`, asks for an owner username/hidden password, and creates the isolated database in ignored `private/`. Protect these with OS permissions. Enter optional credentials privately on **Connections**; never paste them into chat or commit them.

## Real integrations

- Claude Code/Codex CLI: choose an existing server CLI login on Connections. It must be installed, authenticated and support the adapter's safety flags as the OS account running Jarvis. Availability check verifies binaries, not authentication. Never copy Conclave credentials. Antigravity detection is supported; invocation awaits verified isolation. GitHub CLI is not a model provider.
- OpenAI/Anthropic API: select exact model ID and enter API key. These use real provider APIs with bounded read/prepare tools. Chat persists if a provider request fails.
- Google: enable Gmail/Calendar APIs in your own OAuth project, set consent/test users, register the exact callback shown on Connections, save client ID/secret and authorize your account.
- Microsoft: register a confidential web app for your account type, add the exact callback, save app ID/secret/tenant and authorize delegated scopes.
- Open-Meteo: enter home coordinates/name and accept eligible personal-use terms. Live weather caches for 15 minutes. Errors never substitute sample forecasts.

Read permission enables email/calendar access. Prepare adds provider write scopes but every outgoing action requires approval in Inbox. Drafts preserve recipients, subject, body and empty attachments list. Attachments are not supported yet. Reject a draft to prepare a replacement. Keep the worker running for approved sends/events. Uncertain outcomes require provider reconciliation and are never automatically retried.

## Schedules and memory

Supported time expressions: `tomorrow at 9 AM`, `every weekday at 7 AM`, `every day at 7 AM`, `YYYY-MM-DDTHH:mm`. Preview local/IANA and UTC time before confirmation. Actions: reminders, daily briefings, six-hour rain forecasts and individually authorized exact recurring emails. Pause/edit/cancel and history are available. Chat can propose reminders and prepare drafts for Inbox review.

Settings supports editable memories and `.md` imports up to 50 KB. Memories are data, never permissions. The selected model receives recent conversation and selected memory.

## Devices and companions

Log into the PWA on each device for shared state. Settings supports passkeys and per-device Web Push; Inbox is the fallback. iOS push requires a compatible installed Home Screen app.

Optional companions enroll under Devices. Save the one-time configuration privately **outside the repository**, then run `node companion/agent.mjs /private/path/companion.json`. Start with notify only. Linux uses notify-send; Windows shows notifications in its console. Files/commands require explicit server capabilities, local root/command allowlists and interactive local approval. Commands use fixed argv arrays, never arbitrary server shell text. Pending work expires; interrupted execution becomes uncertain. Clipboard is absent.

## Checks

```powershell
npm run check
npm test
npx playwright install chromium
node scripts/browser-check.mjs
```

Tests use local synthetic accounts/SQLite, not live accounts. Browser checks cover login, schedules, memory and all seven sections at desktop/phone widths. Screenshots go in ignored artifacts/. Live account and Pi validation remain required.

See [architecture](docs/architecture.md) and [operations](docs/operations.md). Voice, optional Conclave handoff, attachments and clipboard remain extensions.
