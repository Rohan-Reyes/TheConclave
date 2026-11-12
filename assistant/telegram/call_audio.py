"""Neural speech and owner-only, turn-based Telegram conversations.

No raw audio is saved. Recognition runs locally; response text uses online TTS.
"""
import asyncio
import contextlib
import json
import os
import tempfile

DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural'
VOICES = {DEFAULT_VOICE, 'en-GB-RyanNeural', 'en-US-AvaMultilingualNeural', 'fil-PH-AngeloNeural', 'fil-PH-BlessicaNeural'}


async def synthesize(text, path, voice=DEFAULT_VOICE):
    import edge_tts
    if voice not in VOICES:
        raise ValueError('UnsupportedVoice')
    await asyncio.wait_for(edge_tts.Communicate(str(text)[:2400], voice, rate='-5%').save(path), 40)
    if not os.path.getsize(path):
        raise RuntimeError('EmptySpeech')


class CallAudio:
    def __init__(self, calls, owner_id, config, lock, reply, model_path=None, notify=lambda state: None):
        self.calls, self.owner_id, self.config = calls, owner_id, config
        self.lock, self.reply = lock, reply
        self.notify = notify
        self.model_path = model_path
        self.model = None
        self.session_task = None
        self.playback = None
        self.closed = asyncio.Event()
        self.frames = asyncio.Queue(maxsize=150)
        self.speaking = False
        self.tasks = set()

    async def initialize(self):
        from pytgcalls.types import ChatUpdate, StreamFrames, StreamEnded, Direction, Device

        @self.calls.on_update()
        async def update(_, event):
            if event.chat_id != self.owner_id:
                return  # Never answer, transcribe or send context for another caller.
            if isinstance(event, StreamEnded) and event.stream_type == StreamEnded.Type.AUDIO and event.device == Device.MICROPHONE:
                if self.playback:
                    self.playback.set()
            elif isinstance(event, ChatUpdate):
                if event.status & ChatUpdate.Status.LEFT_CALL:
                    self.closed.set()
                if event.status & ChatUpdate.Status.INCOMING_CALL and self.config.get('conversation_enabled') and self.model is not None:
                    if self.session_task is None and not self.lock.locked():
                        self.session_task = asyncio.create_task(self.converse())
                        self.tasks.add(self.session_task)
                        self.session_task.add_done_callback(self.tasks.discard)
            elif isinstance(event, StreamFrames) and event.direction == Direction.INCOMING:
                if self.session_task and not self.speaking:
                    for frame in event.frames:
                        if not self.frames.full():
                            self.frames.put_nowait(frame.frame)

        if self.config.get('conversation_enabled'):
            if not self.model_path or not os.path.isdir(self.model_path):
                raise RuntimeError('LocalSpeechModelMissing')
            from vosk import Model, SetLogLevel
            SetLogLevel(-1)
            self.model = await asyncio.to_thread(Model, self.model_path)

    async def say(self, text):
        from pytgcalls.types import MediaStream
        self.notify('speaking')
        self.speaking = True
        self.playback = asyncio.Event()
        try:
            with tempfile.TemporaryDirectory(prefix='conclave-neural-') as folder:
                path = os.path.join(folder, 'speech.mp3')
                await synthesize(text, path, self.config.get('voice', DEFAULT_VOICE))
                with contextlib.redirect_stdout(__import__('sys').stderr):
                    await asyncio.wait_for(self.calls.play(self.owner_id, MediaStream(path)), 45)
                end = asyncio.create_task(self.playback.wait())
                hung_up = asyncio.create_task(self.closed.wait())
                try:
                    done, _ = await asyncio.wait([end, hung_up], timeout=180, return_when=asyncio.FIRST_COMPLETED)
                    if not done:
                        raise TimeoutError('PlaybackTimeout')
                finally:
                    for task in (end, hung_up):
                        task.cancel()
                    await asyncio.gather(end, hung_up, return_exceptions=True)
        finally:
            self.playback = None
            self.speaking = False
            while not self.frames.empty():
                self.frames.get_nowait()

    async def listen(self, recognizer):
        # Cap a turn at 20 seconds of 16kHz mono PCM and wait at most 45 seconds.
        size = 0
        async def consume():
            nonlocal size
            while not self.closed.is_set():
                try:
                    chunk = await asyncio.wait_for(self.frames.get(), 1)
                except asyncio.TimeoutError:
                    continue
                size += len(chunk)
                complete = await asyncio.to_thread(recognizer.AcceptWaveform, chunk)
                if complete or size >= 640000:
                    raw = recognizer.Result() if complete else recognizer.FinalResult()
                    text = json.loads(raw).get('text', '').strip()
                    if text:
                        return text[:2000]
                    size = 0
            return ''
        return await asyncio.wait_for(consume(), 45)

    async def converse(self):
        from vosk import KaldiRecognizer
        from pytgcalls.types import RecordStream
        from pytgcalls.types.raw import AudioParameters
        failed = False
        try:
            async with self.lock:
                self.notify('connecting')
                self.closed.clear()
                # Accept only the pending call from the configured owner.
                await asyncio.wait_for(self.calls.play(self.owner_id), 30)
                await self.calls.record(self.owner_id, RecordStream(audio=True, audio_parameters=AudioParameters(bitrate=16000, channels=1)))
                await self.say('Hello. This is Jarvis. I am listening. Please speak English and pause when you finish. Say goodbye to end the call.')
                async with asyncio.timeout(600):
                    while not self.closed.is_set():
                        self.notify('listening')
                        recognizer = KaldiRecognizer(self.model, 16000)
                        try:
                            text = await self.listen(recognizer)
                        except asyncio.TimeoutError:
                            break
                        if not text or self.closed.is_set():
                            break
                        if text in ('goodbye', 'bye jarvis', 'hang up', 'end call', 'stop call'):
                            await self.say('Goodbye.'); break
                        self.notify('thinking')
                        answer = await asyncio.wait_for(self.reply(text), 100)
                        if not self.closed.is_set():
                            await self.say(answer)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Neither transcripts nor raw provider error messages belong in logs.
            failed = True
            self.notify('error')
        finally:
            if not failed:
                self.notify('closed')
            self.closed.set()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.calls.leave_call(self.owner_id), 10)
            self.session_task = None
            while not self.frames.empty():
                self.frames.get_nowait()

    async def close(self):
        self.closed.set()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
