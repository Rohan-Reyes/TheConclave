"""Offline API contract tests; native/network integration remains separate."""
import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from telegram_voice import Settings, TelegramBackend


class Client:
    def __init__(self, *args, **kwargs):
        self.is_connected = self.is_initialized = False

    async def connect(self):
        self.is_connected = True
        return True

    async def get_me(self):
        return object()

    async def initialize(self):
        self.is_initialized = True

    async def terminate(self):
        self.is_initialized = False

    async def disconnect(self):
        self.is_connected = False


class AudioEnded:
    def __init__(self, chat_id):
        self.chat_id = chat_id


class StreamEnded(AudioEnded):
    class Type:
        AUDIO = 1
        VIDEO = 2

    def __init__(self, chat_id, stream_type=1, device=1):
        super().__init__(chat_id)
        self.stream_type = stream_type
        self.device = device


class Media:
    class Flags:
        REQUIRED = 1
        IGNORE = 2

    def __init__(self, path, **kwargs):
        self.path, self.kwargs = path, kwargs


class GroupConfig:
    def __init__(self, *, auto_start):
        self.auto_start = auto_start


class Calls:
    def __init__(self, client):
        self.operations = []
        self.fail = False

    def on_stream_end(self):
        def register(fn):
            self.handler = fn
            return fn
        return register

    async def start(self):
        pass

    async def join_group_call(self, chat_id, stream, *, auto_start):
        self.operations.append(('join', chat_id, auto_start))
        await self.handler(self, AudioEnded(chat_id))

    async def play(self, chat_id, stream, config=None):
        self.operations.append(('play', chat_id, config))
        if self.fail:
            raise RuntimeError('play failed')
        await self.handler(self, StreamEnded(chat_id, StreamEnded.Type.VIDEO))
        await self.handler(self, StreamEnded(chat_id + 1))
        await self.handler(self, StreamEnded(chat_id))

    async def leave_group_call(self, chat_id):
        self.operations.append(('leave_group', chat_id))

    async def leave_call(self, chat_id):
        self.operations.append(('leave', chat_id))


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, release, chat_id, fail=False):
        fake_types = types.ModuleType('pytgcalls.types')
        for name, value in dict(AudioPiped=Media, StreamAudioEnded=AudioEnded,
                                MediaStream=Media, StreamEnded=StreamEnded,
                                GroupCallConfig=GroupConfig,
                                Device=types.SimpleNamespace(MICROPHONE=1)).items():
            setattr(fake_types, name, value)
        modules = {'pyrogram': types.SimpleNamespace(Client=Client),
                   'pytgcalls': types.SimpleNamespace(PyTgCalls=Calls),
                   'pytgcalls.types': fake_types}
        backend = TelegramBackend(Settings(123, 'hash', 'session', chat_id))
        with patch.dict(sys.modules, modules), patch('telegram_voice.version', return_value=release), patch('telegram_voice.shutil.which', return_value='/bin/ffmpeg'):
            await backend.start()
            backend.calls.fail = fail
            try:
                await asyncio.wait_for(backend.play(chat_id, 'audio.mp3'), 0.2)
            finally:
                await backend.close()
        return backend.calls.operations

    async def test_v1_audio_piped_join_and_leave(self):
        self.assertEqual(await self.exercise('1.2.9', -100123),
                         [('join', -100123, False), ('leave_group', -100123)])

    async def test_v1_rejects_direct_calls(self):
        with self.assertRaises(ValueError):
            await self.exercise('1.2.9', 123)

    async def test_v2_group_disables_auto_creation(self):
        operations = await self.exercise('2.2.11', -100123)
        self.assertFalse(operations[0][2].auto_start)
        self.assertEqual(operations[-1], ('leave', -100123))

    async def test_v2_personal_call(self):
        self.assertEqual(await self.exercise('2.2.11', 123),
                         [('play', 123, None), ('leave', 123)])

    async def test_v2_play_failure_propagates(self):
        with self.assertRaises(RuntimeError):
            await self.exercise('2.2.11', 123, fail=True)
