# Conclave 2 unified revision

Conclave is the product. Its personal assistant handles everyday context and commitments; its coding workspace handles project work. Jarvis is incorporated as the assistant engine under `/assistant/`, using the existing Conclave owner login. Both engines run in the same API process and share one origin. The durable scheduler remains a separate worker.

## Included

- Existing coding chats, projects, files, terminal, approvals and execution controls.
- Assistant conversations, colored interactive memory dashboard, browser voice controls, Gmail/calendar connectors, weather, schedules, notifications and device companions from the existing Jarvis source.
- New persistent notes with editing and deletion. A note can become a coding composer draft; the user reviews its scope, agent and workspace and explicitly sends it.
- Shared owner authentication. The assistant accepts identity only from validated in-process Conclave middleware. Caller headers and a Jarvis password cannot bypass that gate. Logout, password revocation and session revocation remove the corresponding assistant session and push subscriptions. Stale assistant browser sessions are removed at startup.
- Namespaced assistant assets, API, service worker, OAuth callbacks and notifications.

## Local setup

Requires Node 24+. Run `npm ci`, copy `.env.example` to a private `.env`, generate two independent 32-byte hexadecimal secrets and set the paths. Use new empty data directories for evaluation.

For a fresh local setup, run `npm run setup` instead of copying the template. It prompts privately for an owner password, generates independent secrets, and writes a private owner file and `.env` without replacing existing credentials.

Run `npm start` and, separately, `npm run worker` from the repository root with the same `.env`. Visit `http://127.0.0.1:4888`, sign in, then choose Personal assistant. The assistant mounts only when `CONCLAVE_ASSISTANT_ENABLED=1`; authentication is required even in local evaluation.

For an eventual production rollout, use `CONCLAVE_PUBLIC_ORIGIN=https://conclave.aten-systems.site`. Register new provider callback URLs:

- `https://conclave.aten-systems.site/assistant/api/oauth/google/callback`
- `https://conclave.aten-systems.site/assistant/api/oauth/microsoft/callback`

OAuth grants must be reconnected at the unified origin. Passkeys remain managed by Conclave. Assistant account/security controls link there. Browser push must be enrolled at the new scoped service worker. Companion enrollment uses the `/assistant` base URL.

## Architecture and data

Browser → Conclave authentication → coding routes or assistant request handler → separate coding/assistant SQLite stores. Worker → assistant SQLite → approved connector actions and notifications. No new public port, proxy, Cloudflare token or tunnel is needed for the assistant.

The stores intentionally retain their existing schemas. Coding memory and assistant memory are still separate; no private project context is copied automatically. Existing production databases, encrypted tokens and owner credentials were not imported. Retain the current encryption key if migrating existing assistant encrypted data later. Never run the old and new workers against the same database during cutover.

## Remaining work before release

This is a development revision, not a completed production cutover. Validate the UI in desktop/mobile browsers and test real provider OAuth, push, companion reconnection and microphone behavior. Plan and verify a backup-based data migration, including memory provenance and existing schedules, before replacing production services. No data was migrated or service restarted for this revision.

Voice retains browser recognition/read-aloud capabilities; full duplex real-time voice is not added here. Official personal Messenger/Instagram inbox access and consumer Gemini chat-history access are not implemented. Coding handoff currently prepares a local browser draft; it is not a background task with synchronized result tracking. Notes do not yet have revision history or graph links. These limitations are not represented as working connectors.

## Validation

`npm test` runs Conclave plus the new shared-login/notes integration test. `npm run test:assistant` runs the inherited assistant tests with local fixtures. No live model or connector calls are required.

## Pre-update fixes (2026-11-11)

- Agent controls now select one or several agents; Council is a separate toggle for the selected subset. Selection persists for both existing and new chats, and combos appear in chat labels.
- Streaming output, working indicators and queued messages cannot shrink the message box out of view. Drafts remain usable while replies arrive.
- Chat headers and project pages provide a read-only Plan quick view.
- Runner discovers hub-only project folders, shows empty-state guidance, allows custom commands and folder changes in its popup, preserves the popup during confirmation, and merges replayed/snapshot logs so fast commands do not appear blank. Custom arguments accept a JSON string array for spaces and quotes.
- The browser passkey library is served directly from the installed dependency, fixing a missing vendor asset.

Run `npm run test:chat-ui` with Playwright Chromium installed, or set `CONCLAVE_BROWSER` to a compatible Chromium executable. The synthetic browser check covers agent selection/persistence, new chat selection, plan views, npm/custom command confirmation and output (including delayed log subscription), and composer visibility/draft retention during simulated streaming at desktop, phone and landscape sizes. It invokes no live model. Real connector and production migration checks remain outstanding.

## Skills, global settings and adding details

Open **Agents & tools → Skills** to install a pasted `SKILL.md` or a skill package from an absolute server folder. Preview lists the files and targets. Installation verifies the reviewed content digest, rejects symlinks and oversized packages, preserves supporting resources, and refuses to overwrite an existing skill. It does not download repositories or run installation scripts. Clone an external skill repository separately, then select the intended skill folder. Native CLI sessions discover installed skills according to their own loading behavior.

**Variables & secrets** stores shared values encrypted in the coding database using `TOKEN_ENCRYPTION_KEY`. Configure that independent 32-byte key privately in `.env` (the local setup command generates it). The key is never stored in the database. Select the coding agents or Runner that may receive each variable. Values become environment variables for new processes; running processes keep their existing environment. Secret values are not returned in listing/edit responses or inserted into model prompts. Models see granted variable names only. The application's encryption/session keys are removed from agent and Runner child environments. Do not put credential values in prompts; enter them in the private variable form. No existing Cloudflare token was imported from chat.

Variables and prompts are global within this installation, not automatically copied by project synchronization to other machines. Retain and back up the encryption key separately from the encrypted database. Changing it without migration makes existing encrypted values unreadable.

**Global prompts** adds enabled, owner-written instructions to selected coding agents on every new turn, and to the personal assistant. This is separate from the existing editor for native tool instruction files, which also affect sessions outside Conclave. Disabled entries do not enter prompts. Tool permissions and sandbox policies remain enforced by the application and each CLI. Codex's own shell environment policy may further filter environment variables; see [official OpenAI configuration documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy).

**Alt+M**, **Ctrl+Enter** while working, or **Add details** records a context addition without stopping the active run. Enter still queues a follow-up. An empty Alt+M focuses the composer. The pending update is retained in the transcript with an idempotent request ID. Each active agent can read it using the new memory MCP tool `get_task_updates`; Conclave prompts instruct agents to check at milestones, before consequential changes, and before replying. Each agent has a separate indexed cursor, and the UI shows which have checked the latest update. Agents need the updated memory MCP server for this tool. A CLI which does not check cannot absorb text into an already-built prompt; unread additions remain available in the next model turn. No interruption or automatic replacement run is used. The legacy API `mode=now` still supports explicit interruption for existing clients, but the chat's Add details shortcut does not use it.

Cleanup includes fresh dialog bodies per opening (preventing retained input listeners), stale-preview invalidation, bounded skill packages/global prompts, and an index for context-update reads. `npm run format:check` checks the new modules. The browser harness now covers secret masking, prompt toggles, skill installation, mobile settings, and the Alt+M request without a stop call, in addition to the earlier chat/Runner checks. Engine tests verify the original run finishes normally after details are added and that the selected process receives credentials without the master encryption key.

## Reply cards and agent logos

AI reply cards now keep their content height within the scrolling transcript, fixing flex compression while the agent thinks, writes or uses tools. The earlier fix for the owner's typing box remains in place. The synthetic browser test checks that long streaming reply cards do not clip their content and the typing box stays visible at desktop, phone and landscape sizes.

The team circles, reply headers and working indicators use bundled logos for Claude, OpenAI/Codex, Antigravity, GitHub Copilot, Gemini, Ollama and Qwen. Unknown custom agents retain an escaped initial. Logos are loaded from local static files, not a third-party image server. Source/version and the MIT license are recorded under `public/brand/`; the SVG artwork comes from [Lobe Icons](https://github.com/lobehub/lobe-icons). Browser checks verify the logo images actually load.

## Unified navigation and memory refresh

Management, 3D Memory, Connectors, Tasks and Telegram now open inside Conclave's persistent sidebar and mobile navigation. The assistant content is a same-origin authenticated frame; only the integrated assistant permits same-origin framing. Standalone assistant responses retain frame denial. Legacy `/assistant/#...` links redirect to the corresponding Conclave route. Both interfaces load `public/theme.css`, and theme changes propagate immediately to assistant content. The version badge reads the server version.

The memory map adds an accessible searchable list, in-place editing/deletion for personal memories, an add-memory form, stronger light-mode category colors, and a refresh notification when the saved graph changes. Shared coding memories retain their source and link to the coding memory editor. Similarity links are described as inferred. Map questions reuse the dedicated Jarvis conversation.

Telegram now accepts API ID, API hash, numeric owner ID and an authorized **Telethon** StringSession in the private settings form. Hash/session inputs remain blank after saving; blank inputs retain saved credentials. Values remain encrypted in the assistant database. Replacing credentials disables delivery/calls/notifications and cancels queued actions for the old destination. Credentials are syntactically checked at save time; Telegram authorization is verified only after enabling the connection. Existing authorized sessions may be retained when changing the destination. Userbot phone/code/two-step login is still performed privately through the enrollment command; no phone-login web flow was added. A Pyrogram session from the separate Python voice module is not interchangeable with this Telethon connector.

Run `node scripts/check-management-ui.mjs` with Playwright installed (optionally set `CONCLAVE_BROWSER`) for synthetic desktop/mobile checks of persistent navigation, theme tokens, map editing/search, masked Telegram fields and legacy redirects. It invokes no live model, TTS or Telegram service.

## Natural Telegram speech and incoming voice conversations

Telegram alerts now use Edge neural TTS instead of eSpeak. The default is Andrew multilingual, with British male, multilingual female and Filipino voice choices in Telegram settings. This sends reply text to Microsoft's online TTS service. There is no silent robotic fallback. Playback waits for the audio-end event instead of estimating speech length.

The owner may enable incoming conversational calls from the separate userbot account. Only the configured numeric owner ID is answered. Recognition uses a local Vosk English model configured with `TELEGRAM_STT_MODEL`; install the small English model from https://alphacephei.com/vosk/models outside the repository. Dependencies are in `assistant/telegram/requirements.txt`. The model is loaded off the async loop. Incoming PCM stays in a bounded memory queue; no raw audio recording is retained. The recognized text and model reply are stored in the existing Jarvis conversation, with Telegram voice provenance. Relevant memory retrieval and existing task/approval tools remain in use.

This is **turn-based**, not a full duplex realtime session: pause after speaking and wait for the answer. Audio received while Jarvis speaks is discarded to avoid feedback; barge-in is not implemented. English is the supported recognition language; Filipino/Taglish recognition is unverified. Calls stop on hangup, a recognized goodbye/end-call phrase, 45 seconds waiting for speech or the ten-minute session limit. The configured model may add response latency (especially CLI providers). The Telegram page displays the last voice-call state without logging speech or credentials.

Offline tests cover owner gating, disabled calls, local-turn handling, playback cleanup and reuse of the Jarvis conversation. Neural TTS and local recognition were smoke-tested on the Pi. A real incoming Telegram call is still required to validate the complete media path, echo behavior, recognition accuracy and reply latency.
