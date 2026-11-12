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
    async def test_incoming_uses_explicit_media_and_survives_greeting_failure(self):
        self.types.RecordStream=lambda **kw:kw
        self.types.ExternalMedia=types.SimpleNamespace(AUDIO='external-audio')
        self.calls.play=AsyncMock();self.calls.record=AsyncMock();self.calls.leave_call=AsyncMock()
        self.audio.say=AsyncMock(side_effect=[RuntimeError('speech unavailable'),None])
        self.audio.listen=AsyncMock(return_value='goodbye')
        states=[];self.audio.notify=lambda state,detail=None:states.append(state)
        fake_vosk=types.SimpleNamespace(KaldiRecognizer=lambda *args:object())
        fake_raw=types.SimpleNamespace(AudioParameters=lambda **kw:kw)
        with patch.dict(sys.modules,{'vosk':fake_vosk,'pytgcalls.types.raw':fake_raw}):
            await self.audio.converse()
        self.calls.play.assert_awaited_once_with(123,'external-audio')
        self.audio.listen.assert_awaited_once()
        self.assertIn('speech_unavailable',states);self.assertNotIn('error',states)
    async def test_owner_audio_is_queued_while_jarvis_speaks(self):
        self.audio.session_task=object();self.audio.speaking=True
        event=StreamFrames();event.chat_id=999;event.direction=1;event.frames=[types.SimpleNamespace(frame=b'private')]
        await self.calls.handler(None,event);self.assertTrue(self.audio.frames.empty())
        event.chat_id=123;await self.calls.handler(None,event)
        self.assertEqual(await self.audio.frames.get(),b'private')
    async def test_local_turn_recognition(self):
        recognizer=types.SimpleNamespace(AcceptWaveform=lambda b:True,Result=lambda:'{"text":"hello jarvis"}')
        await self.audio.frames.put(b'\0'*3200)
        self.assertEqual(await self.audio.listen(recognizer),'hello jarvis')

class InterruptionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls=types.SimpleNamespace(play=AsyncMock())
        self.audio=CallAudio(self.calls,123,{},asyncio.Lock(),AsyncMock())
        self.fake_types=types.SimpleNamespace(MediaStream=lambda p:p,ExternalMedia=types.SimpleNamespace(AUDIO='external'))
        self.patch=patch.dict(sys.modules,{'pytgcalls.types':self.fake_types});self.patch.start()
    async def asyncTearDown(self):
        await self.audio.close();self.patch.stop()
    async def test_interrupt_cancels_synthesis_and_preserves_owner_audio(self):
        started=asyncio.Event();cancelled=asyncio.Event()
        async def slow(*args):
            started.set()
            try:await asyncio.Event().wait()
            finally:cancelled.set()
        with patch('call_audio.synthesize',slow):
            task=asyncio.create_task(self.audio.say('long reply'))
            await started.wait();await self.audio.frames.put(b'owner-audio')
            await self.audio.interrupt()
            self.assertFalse(await asyncio.wait_for(task,1))
        self.assertTrue(cancelled.is_set());self.calls.play.assert_awaited_once_with(123,'external')
        self.assertEqual(await self.audio.frames.get(),b'owner-audio')
    async def test_interrupt_replaces_playback_without_hanging_up(self):
        started=asyncio.Event();paths=[]
        async def save(text,path,voice):paths.append(path);Path(path).write_bytes(b'fixture')
        async def play(owner,path):
            if path!='external':started.set()
        self.calls.play.side_effect=play
        with patch('call_audio.synthesize',save):
            task=asyncio.create_task(self.audio.say('long reply'))
            await started.wait();await self.audio.interrupt()
            self.assertFalse(await asyncio.wait_for(task,1))
        self.assertFalse(self.audio.closed.is_set());self.assertFalse(self.audio.speaking)
        self.assertTrue(all(not Path(p).exists() for p in paths))
    async def test_failed_speech_sends_one_text_fallback(self):
        self.audio.text_fallback=AsyncMock()
        with patch('call_audio.synthesize',AsyncMock(side_effect=RuntimeError)):
            self.assertFalse(await self.audio.safe_say('useful reply'))
        self.audio.text_fallback.assert_awaited_once_with('useful reply')
    async def test_interrupted_reply_does_not_send_text_fallback(self):
        self.audio.interrupted.set();self.audio.text_fallback=AsyncMock()
        self.assertFalse(await self.audio.safe_say('old reply'));self.audio.text_fallback.assert_not_awaited()
    async def test_neural_voice_failure_tries_another_voice(self):
        from call_audio import synthesize,DEFAULT_VOICE
        import tempfile
        chosen=[]
        class FakeSpeech:
            def __init__(self,text,voice,**kw):chosen.append((voice,kw))
            async def save(self,path):
                if len(chosen)==1:raise RuntimeError('NoAudioReceived')
                Path(path).write_bytes(b'audio')
        with patch.dict(sys.modules,{'edge_tts':types.SimpleNamespace(Communicate=FakeSpeech)}),tempfile.TemporaryDirectory() as folder:
            await synthesize('hello',folder+'/speech.mp3')
        self.assertEqual([v for v,_ in chosen],[DEFAULT_VOICE,'en-US-AndrewMultilingualNeural'])
        self.assertTrue(all(kw['rate']=='+0%' for _,kw in chosen))
    async def test_continuous_recognition_interrupts_and_keeps_new_turn(self):
        from array import array
        class Recognizer:
            def __init__(self,*args):pass
            def AcceptWaveform(self,data):return True
            def PartialResult(self):return '{"partial":"stop"}'
            def Result(self):return '{"text":"stop"}'
        self.audio.speaking=True
        with patch.dict(sys.modules,{'vosk':types.SimpleNamespace(KaldiRecognizer=Recognizer)}):
            task=asyncio.create_task(self.audio._recognize())
            await self.audio.frames.put(array('h',[2000]*3200).tobytes())
            turn=await asyncio.wait_for(self.audio.turns.get(),1)
            self.assertEqual(turn,'stop');self.assertTrue(self.audio.interrupted.is_set())
            self.calls.play.assert_awaited_once_with(123,'external')
            task.cancel();await asyncio.gather(task,return_exceptions=True)

class SpeechGateTests(unittest.TestCase):
    def test_noise_and_echo_do_not_interrupt_but_sustained_words_do(self):
        from call_audio import SpeechGate
        from array import array
        gate=SpeechGate();gate.feed(bytes(6400));self.assertFalse(gate.speaking('hello'))
        gate.feed(array('h',[1500]*3200).tobytes());self.assertTrue(gate.speaking('stop'))
        self.assertFalse(gate.speaking('hello how are you','Hello how are you today'))

class SpeechTextTests(unittest.TestCase):
    def test_spoken_chunks_remove_markup_and_keep_content_bounded(self):
        from call_audio import spoken_text,speech_chunks
        text='Here is **your update**. '+('A useful sentence with context. '*25)
        clean=spoken_text(text);chunks=speech_chunks(text)
        self.assertTrue(all(len(c)<=220 for c in chunks));self.assertEqual(' '.join(chunks),clean)
        self.assertNotIn('**',clean)
