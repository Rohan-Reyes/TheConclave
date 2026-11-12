import asyncio
from enum import IntFlag
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch, AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from call_audio import CallAudio, DEFAULT_VOICE, synthesize

class ChatUpdate:
    class Status(IntFlag):
        INCOMING_CALL=1
        LEFT_CALL=2
    def __init__(self,chat_id,status):self.chat_id,self.status=chat_id,status
class StreamEnded:
    class Type:AUDIO=1
class StreamFrames:pass
class FakeCalls:
    def on_update(self):
        def register(fn):self.handler=fn;return fn
        return register
    async def play(self,owner,stream):self.audio.playback.set()

class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls=FakeCalls()
        self.audio=CallAudio(self.calls,123,{},asyncio.Lock(),AsyncMock())
        self.calls.audio=self.audio
        self.types=types.SimpleNamespace(ChatUpdate=ChatUpdate,StreamFrames=StreamFrames,StreamEnded=StreamEnded,Direction=types.SimpleNamespace(INCOMING=1),Device=types.SimpleNamespace(MICROPHONE=1),MediaStream=lambda p:p)
        self.patch=patch.dict(sys.modules,{'pytgcalls.types':self.types});self.patch.start()
        await self.audio.initialize()
    async def asyncTearDown(self):
        await self.audio.close();self.patch.stop()
    async def test_only_owner_can_start_conversation(self):
        self.audio.config['conversation_enabled']=True;self.audio.model=object()
        self.audio.converse=AsyncMock()
        await self.calls.handler(None,ChatUpdate(999,ChatUpdate.Status.INCOMING_CALL));await asyncio.sleep(0)
        self.audio.converse.assert_not_awaited()
        await self.calls.handler(None,ChatUpdate(123,ChatUpdate.Status.INCOMING_CALL));await asyncio.sleep(0)
        self.audio.converse.assert_awaited_once()
    async def test_disabled_calls_not_answered(self):
        self.audio.converse=AsyncMock()
        await self.calls.handler(None,ChatUpdate(123,ChatUpdate.Status.INCOMING_CALL));await asyncio.sleep(0)
        self.audio.converse.assert_not_awaited()
    async def test_speech_waits_and_cleans_file(self):
        paths=[]
        async def save(text,path,voice):paths.append(path);Path(path).write_bytes(b'fixture')
        with patch('call_audio.synthesize',save):await self.audio.say('hello')
        self.assertTrue(all(not Path(p).exists() for p in paths));self.assertFalse(self.audio.speaking)
    async def test_tts_failure_resets_speaking(self):
        with patch('call_audio.synthesize',AsyncMock(side_effect=RuntimeError)):
            with self.assertRaises(RuntimeError):await self.audio.say('hello')
        self.assertFalse(self.audio.speaking)
    async def test_owner_hangup_sets_closed(self):
        await self.calls.handler(None,ChatUpdate(999,ChatUpdate.Status.LEFT_CALL));self.assertFalse(self.audio.closed.is_set())
        await self.calls.handler(None,ChatUpdate(123,ChatUpdate.Status.LEFT_CALL));self.assertTrue(self.audio.closed.is_set())
    async def test_local_turn_recognition(self):
        recognizer=types.SimpleNamespace(AcceptWaveform=lambda b:True,Result=lambda:'{"text":"hello jarvis"}')
        await self.audio.frames.put(b'\0'*3200)
        self.assertEqual(await self.audio.listen(recognizer),'hello jarvis')
