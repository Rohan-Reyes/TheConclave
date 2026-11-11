"""Queued Telegram voice alerts. Import has no network or lifecycle side effects.

Use a dedicated Pyrogram user session, not a bot token or a Telethon session.
Only the explicitly configured TELEGRAM_CHAT_ID may receive alerts.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from importlib.metadata import version
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    api_id: int
    api_hash: str = field(repr=False)
    session_string: str = field(repr=False)
    chat_id: int
    voice: str = 'en-US-AriaNeural'

    @classmethod
    def from_env(cls):
        try:
            settings = cls(
                int(os.environ['TELEGRAM_API_ID']),
                os.environ['TELEGRAM_API_HASH'],
                os.environ['TELEGRAM_SESSION_STRING'],
                int(os.environ['TELEGRAM_CHAT_ID']),
                os.getenv('TELEGRAM_TTS_VOICE', 'en-US-AriaNeural'),
            )
        except (KeyError, ValueError):
            raise ValueError('Set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING and TELEGRAM_CHAT_ID') from None
        if settings.api_id <= 0 or not settings.api_hash or not settings.session_string or not settings.chat_id:
            raise ValueError('Invalid Telegram configuration')
        return settings


@dataclass(frozen=True)
class DeliveryResult:
    success: bool
    error: str | None = None


class TelegramBackend:
    """Compatibility adapter for the tested 1.2.9 and 2.2.11 APIs."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = self.calls = None
        self.pending: tuple[int, asyncio.Event] | None = None

    async def start(self):
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            raise RuntimeError('ffmpeg and ffprobe are required')
        from pyrogram import Client
        from pytgcalls import PyTgCalls
        release = version('py-tgcalls')
        if release not in ('1.2.9', '2.2.11'):
            raise RuntimeError('Use a tested py-tgcalls profile: 1.2.9 or 2.2.11')
        self.legacy = release == '1.2.9'
        if self.legacy:
            from pytgcalls.types import AudioPiped
            from pytgcalls.types import StreamAudioEnded
            self.audio_type = StreamAudioEnded
            self.make_stream = AudioPiped
        else:
            from pytgcalls.types import MediaStream, StreamEnded, GroupCallConfig, Device
            self.audio_type = StreamEnded
            self.device = Device
            self.group_config = GroupCallConfig
            self.make_stream = lambda path: MediaStream(
                path, audio_flags=MediaStream.Flags.REQUIRED,
                video_flags=MediaStream.Flags.IGNORE,
            )
        self.client = Client('jarvis-voice', api_id=self.settings.api_id,
                             api_hash=self.settings.api_hash,
                             session_string=self.settings.session_string,
                             in_memory=True)
        try:
            # Never prompt for phone/code inside a server lifecycle.
            if not await self.client.connect():
                raise RuntimeError('Authorize a Pyrogram session privately first')
            await self.client.get_me()
            await self.client.initialize()
            self.calls = PyTgCalls(self.client)

            @self.calls.on_stream_end()
            async def ended(_, update):
                if not isinstance(update, self.audio_type):
                    return
                if not self.legacy and (
                    update.stream_type != self.audio_type.Type.AUDIO
                    or update.device != self.device.MICROPHONE
                ):
                    return
                if self.pending and update.chat_id == self.pending[0]:
                    self.pending[1].set()

            await self.calls.start()
        except BaseException:
            await self.close()
            raise

    async def play(self, chat_id: int, path: str):
        if self.legacy and chat_id > 0:
            raise ValueError('Direct user calls require py-tgcalls 2.2.11; 1.2.9 supports group voice chats only')
        done = asyncio.Event()
        self.pending = (chat_id, done)
        try:
            stream = self.make_stream(path)
            if self.legacy:
                await self.calls.join_group_call(chat_id, stream, auto_start=False)
            elif chat_id < 0:
                await self.calls.play(chat_id, stream, self.group_config(auto_start=False))
            else:
                await self.calls.play(chat_id, stream)
            await done.wait()  # Actual audio-end event, not estimated speech duration.
        finally:
            self.pending = None
            try:
                leave = self.calls.leave_group_call if self.legacy else self.calls.leave_call
                await asyncio.wait_for(leave(chat_id), 10)
            except Exception as error:
                log.warning('Telegram leave failed (%s)', type(error).__name__)

    async def close(self):
        # These releases expose no public PyTgCalls.stop(). Leave is per alert;
        # the dedicated MTProto client is disconnected at application shutdown.
        if self.client is not None:
            try:
                if self.client.is_initialized:
                    await asyncio.wait_for(self.client.terminate(), 10)
            finally:
                if self.client.is_connected:
                    await asyncio.wait_for(self.client.disconnect(), 10)
                self.client = None


async def edge_synthesize(text: str, path: str, voice: str):
    import edge_tts
    await edge_tts.Communicate(text, voice).save(path)  # MP3; decoded by ffmpeg.


class TelegramVoice:
    def __init__(self, settings: Settings, *, backend=None,
                 synthesize: Callable[[str, str, str], Awaitable[None]] = edge_synthesize,
                 queue_size: int = 32, alert_timeout: float = 180):
        if queue_size < 1 or alert_timeout <= 0:
            raise ValueError('Queue size and timeout must be positive')
        self.settings = settings
        self.backend = backend if backend is not None else TelegramBackend(settings)
        self.synthesize = synthesize
        self.queue = asyncio.Queue(maxsize=queue_size)
        self.alert_timeout = alert_timeout
        self.task = None
        self.accepting = False
        self.lifecycle = asyncio.Lock()
        self.closed = False

    async def start(self):
        async with self.lifecycle:
            if self.closed:
                raise RuntimeError('Create a new TelegramVoice after shutdown')
            if self.accepting:
                return
            await asyncio.wait_for(self.backend.start(), 45)
            self.task = asyncio.create_task(self._worker(), name='telegram-voice')
            self.accepting = True

    async def enqueue_call(self, chat_id: int, text: str) -> asyncio.Future:
        """Return a receipt immediately; await the receipt separately for delivery.

        A full queue raises QueueFull rather than blocking the intent loop.
        """
        if not self.accepting:
            raise RuntimeError('Telegram voice is not running')
        if type(chat_id) is not int or chat_id != self.settings.chat_id:
            raise ValueError('Target must match TELEGRAM_CHAT_ID')
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise ValueError('Alert text must contain 1–4000 characters')
        receipt = asyncio.get_running_loop().create_future()
        self.queue.put_nowait((chat_id, text.strip(), receipt))
        return receipt

    async def _deliver(self, chat_id, text):
        with tempfile.TemporaryDirectory(prefix='jarvis-voice-') as folder:
            path = str(Path(folder) / 'alert.mp3')
            await self.synthesize(text, path, self.settings.voice)
            await self.backend.play(chat_id, path)

    async def _worker(self):
        while True:
            chat_id, text, receipt = await self.queue.get()
            try:
                await asyncio.wait_for(self._deliver(chat_id, text), self.alert_timeout)
                result = DeliveryResult(True)
            except asyncio.CancelledError:
                if not receipt.done():
                    receipt.cancel()
                raise
            except Exception as error:
                # No retry: an uncertain call must not ring the owner twice.
                name = type(error).__name__
                log.warning('Telegram voice alert failed (%s)', name)
                result = DeliveryResult(False, name)
            finally:
                self.queue.task_done()
            if not receipt.done():
                receipt.set_result(result)

    async def close(self, *, drain: bool = True, timeout: float = 30):
        async with self.lifecycle:
            if self.closed:
                return
            self.accepting = False
            try:
                if drain and self.task is not None:
                    try:
                        await asyncio.wait_for(self.queue.join(), timeout)
                    except asyncio.TimeoutError:
                        pass
            finally:
                if self.task is not None:
                    self.task.cancel()
                    try:
                        await self.task
                    except asyncio.CancelledError:
                        pass
                while not self.queue.empty():
                    _, _, receipt = self.queue.get_nowait()
                    if not receipt.done():
                        receipt.cancel()
                    self.queue.task_done()
                self.closed = True
                await self.backend.close()
