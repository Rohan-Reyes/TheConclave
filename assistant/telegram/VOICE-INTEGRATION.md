# Python Telegram voice worker

`telegram_voice.py` is an opt-in Python/asyncio module. The discovered production Jarvis service is Node.js (`/opt/jarvis/current/src/server.js`), so it has **not** been imported into that service or substituted for its existing Telethon/PyTgCalls 3.x bridge. Use the following hooks in your Python core. No call is made on import or startup; only explicit enqueueing creates an alert.

## Call semantics and versions

- Negative group/supergroup chat ID: joins an **existing** voice chat. The owner must already be listening there; this does not ring their personal device. Group voice chat creation is disabled (`auto_start=False`). The user session needs membership and speaking permissions.
- Positive personal user ID: initiates a direct outgoing call using **2.2.11**; the recipient must answer. Requires a separate calling account. Version **1.2.9** rejects positive IDs.
- 1.2.9 uses `AudioPiped` and `StreamAudioEnded`; 2.2.11 uses its replacement `MediaStream` and `StreamEnded`. Both wait for the actual audio-end event. Only these exact releases are accepted, rather than claiming compatibility with every 1.x/2.x release.

Use a dedicated virtual environment (Python 3.10/3.11 recommended for native-wheel compatibility), **not** the existing Telegram bridge environment:

```bash
python3.11 -m venv .venv-telegram-voice
.venv-telegram-voice/bin/pip install -r requirements-voice-v2.txt
# Or requirements-voice-v1.txt for group-only AudioPiped support.
```

Install system `ffmpeg` (including `ffprobe`). Native ntgcalls wheel availability must be checked for your OS/Python/ARM64 combination; mocked tests do not establish Pi native compatibility. Never replace the live bridge dependencies to resolve that.

## Private environment

```dotenv
TELEGRAM_API_ID=<application ID>
TELEGRAM_API_HASH=<application hash>
TELEGRAM_CHAT_ID=<the one allowed destination ID>
TELEGRAM_SESSION_STRING=<privately authorized Pyrogram USER session>
TELEGRAM_TTS_VOICE=en-US-AriaNeural
```

Load these with your service manager or private environment loader. No values belong in Git. An API ID/hash alone is insufficient. Authorize a **Pyrogram** user session separately in a private interactive terminal and export its session string there; the existing Telethon session string is incompatible. The daemon does not prompt for login codes. Pyrogram credentials use an in-memory session; they are not persisted by this worker.

`edge-tts` sends the alert text to Microsoft's online speech service. It writes an MP3 inside a private temporary directory; ffmpeg decodes it. Temporary files are removed after success, failure, timeout or normal cancellation. Abrupt power loss/SIGKILL cannot run cleanup.

## FastAPI lifespan hook

Place `telegram_voice.py` beside your Python entry point, or import it from your package. Merge this lifecycle logic into your existing lifespan so existing startup/shutdown logic remains intact:

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from telegram_voice import Settings, TelegramVoice

@asynccontextmanager
async def lifespan(app: FastAPI):
    voice = TelegramVoice(Settings.from_env())
    await voice.start()
    app.state.telegram_voice = voice
    try:
        yield
    finally:
        await voice.close(drain=True, timeout=30)

app = FastAPI(lifespan=lifespan)

# Call from your existing authorized intent/task handler, not a public endpoint.
async def voice_alert(app: FastAPI, text: str):
    voice = app.state.telegram_voice
    receipt = await voice.enqueue_call(voice.settings.chat_id, text)
    return receipt
```

## Existing asyncio daemon hook

```python
import asyncio
from telegram_voice import Settings, TelegramVoice

async def main():
    telegram_voice = TelegramVoice(Settings.from_env())
    await telegram_voice.start()
    try:
        # Inject this object into your existing intent/task executor:
        # await run_existing_jarvis(telegram_voice=telegram_voice)
        await run_existing_jarvis(telegram_voice=telegram_voice)
    finally:
        await telegram_voice.close(drain=True, timeout=30)

# In the existing intent handler:
async def handle_alert(telegram_voice, text):
    receipt = await telegram_voice.enqueue_call(
        telegram_voice.settings.chat_id, text
    )
    # Enqueued immediately. Keep doing other work.
    # Await receipt later only if this handler needs the playback outcome:
    # result = await receipt
    # result.success / result.error (sanitized exception type only)
    return receipt

# Keep the existing entry point if the process already owns an event loop.
# For a standalone daemon only:
# asyncio.run(main())
```

Do not call `asyncio.run` inside a running application. Create one worker per calling account/process, not one per request. Multiple OS workers sharing a session are not coordinated by this in-process queue; deploy one voice owner or use an external queue for that architecture.

## Delivery and shutdown behavior

The bounded FIFO queue holds 32 pending alerts by default. Enqueue raises `asyncio.QueueFull` immediately under overload; catch this in your existing handler and report that the alert was not accepted. Only the configured destination is allowed. Empty/oversized messages are rejected.

The returned future resolves to `DeliveryResult(success, error)`. It does not raise provider errors if ignored. Canceling the receipt does not retract an already queued alert. Alerts have a configurable 180-second total timeout including synthesis, dialing and playback, followed by bounded leave cleanup. Calls are never retried automatically because an error may occur after the recipient already heard the message. Delivery failure does not kill the worker or include raw provider errors in logs.

`close(drain=True)` stops accepting requests, gives queued work up to 30 seconds, then cancels remaining receipts, leaves any active call and disconnects the dedicated MTProto client. PyTgCalls 1.2.9/2.2.11 expose no public `stop()` lifecycle API; a worker instance is single-lifecycle and cannot restart after close. Application process shutdown releases remaining library-global native resources. For repeated hot reload in a long-lived host, isolate this module in a process rather than using private PyTgCalls internals.

Tests (no credentials, network, TTS request, message or call):

```bash
python3 -m unittest discover -s assistant/telegram/tests -v
```

## API references

- [PyTgCalls 1.2.9 release/source wheel](https://pypi.org/project/py-tgcalls/1.2.9/)
- [PyTgCalls 2.2.11 release/source wheel](https://pypi.org/project/py-tgcalls/2.2.11/)
- [Pyrogram session strings](https://docs.pyrogram.org/topics/storage-engines#session-strings)
- [edge-tts usage](https://github.com/rany2/edge-tts)
