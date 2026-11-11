# Conclave roadmap

## Done
- Chat history for Claude Code, Antigravity and Codex, with full-text search, transcripts, and resume in terminal
- Shared memory through an MCP server, connected to all three tools
- Projects (inferred from the folders each chat touched), git status, instruction-file editor
- Config: MCP servers × tools, skills × tools, global instruction files, all with diffs and backups
- Conclave chat: talk to any tool and switch mid-chat with full context, @mention hand-offs between agents
- Council modes: **Debate** (answer → review → verdict → run the plan) and **Build & review** (lead builds → others review the real files → lead fixes)
- File & link chips on replies with preview, Open in VS Code, Show in folder
- Usage page: tokens/cost per tool and day, Claude rate-limit window, Conclave run costs
- Extra agents: presets (Gemini CLI, Ollama, Aider, OpenCode, Copilot CLI, Qwen, Goose, llm) and custom CLIs
- `council_ask` / `agent_ask` MCP tools, so any terminal session can consult the others
- Ctrl+K search, desktop notifications, Markdown export
- **Permission prompts in the browser** (Claude: Allow / Always allow / Deny cards)
- **Diff view per reply** with one-click revert (git repos and small non-git folders)
- **Quick chats** without picking a folder (each gets ~/Conclave/<date>-<id>)
- **Model + effort picker** per tool, per chat
- **Plan limits**: Claude 5h/weekly, Codex 5h/weekly, Antigravity `/usage` quotas
- **Council plans** (by Claude, via the council): verdict → validated plan → Run plan with Pause / Cancel / Retry / Skip / Reassign; approval modes Auto / Ask on risk / Manual
- **Questions from agents**: `ask_user` tool + question cards with choice pills
- **Team roles** (lead, builder, reviewer, tester, researcher, designer, benched) and **usage-aware balancing**: every prompt carries the team's roles and live limits
- **Direct terminal access** for all agents (default), Codex MCP auto-approval, **stall watchdog** with hand-over
- **Live animations** (thinking / writing / running a command), **message queue + Send now**, **full-screen / collapsible chat list**
- **Out-of-credits failover**: detect quota errors, try Antigravity's other quota bucket, hand the turn to the next agent, skip exhausted council members, and when everyone is out wait and resume after the earliest reset
- **Failure kinds kept apart**: out of credits, failed to start and stalled each get their own message; only a genuinely exhausted team waits for a reset, and a council member's turn never claims the whole team is out
- **Guarded restart recovery**: completed steps keep their checkpoint; a build step interrupted mid-edit waits for Retry or Skip; plans auto-resume only in Auto mode with write access when it is safe, re-checked at resume time
- **Honest usage labels**: expired windows ignored, percentages capped at 100%, "usage unknown" instead of zero, Copilot shown as latest-session usage
- **Mobile layout**: chat drawer, ⋯ actions menu, composer and conversation sized for phone, landscape and reduced-height screens, checked by an isolated browser matrix

## Next (high value, small)
1. **Approvals for Codex and Antigravity.** Drive `codex app-server` / agy's interactive mode so they can ask too (today only Claude can).
2. **Git worktree per agent** in build councils, so parallel builders never clash; merge the winner.
3. **Native image forwarding.** Use image inputs directly in every driver that supports them; show compatibility for path-based attachments.
4. **Custom templates.** Save your own prompts and preferred council settings.
5. **Pinned context.** Pin memories or files to a chat so every agent always gets them.
6. **Real-device mobile testing.** Verify software keyboards, browser chrome, safe areas and touch on physical iOS/Android phones; add `visualViewport` handling if they need it.
7. **Publish CI.** Push the prepared `.github/workflows/checks.yml` once a credential with GitHub's `workflow` scope is available.

## Later
- **Plan transaction isolation:** keep build, review and fix on the same isolated worktree; writes are currently serialized but another chat may edit between phases.
- **Git commit helper, automatic titles and daily budgets:** deferred from v1.0.
- **Scheduled councils:** run a council nightly (e.g. review today's commits) and notify.
- **Voting mode:** each agent scores the others' answers; the best one wins automatically.
- **Memory hygiene:** detect duplicate or stale memories, suggest merges, and expire project facts after N days.
- **Semantic search** over chats and memory (local embeddings with Ollama).
- **Local last resort:** auto-add Ollama as the final fallback once installed, so work continues offline.
- **Cost budgets:** warn or stop a chat when it passes a token or $ limit; per-day caps.
- **Remote access:** sign-in plus a tunnel to use Conclave from your phone (needs auth first: today it only listens on 127.0.0.1).
- **More history sources:** Cursor, Windsurf, Gemini CLI, Aider chat history import.
- **Two-way sync** of memory to each tool's native memory (CLAUDE.md sections, AGENTS.md, Antigravity knowledge) for offline use.
- **Plugin API:** drop a JS file in `agent-hub/plugins` to add an agent driver, a page, or an MCP tool.
