"""Owner-only Telegram voice with local recognition and interruptible neural speech."""
import asyncio
import contextlib
import json
import math
import os
import re
import tempfile
import time
import unicodedata
import uuid
from array import array

DEFAULT_VOICE = 'en-GB-RyanNeural'
VOICES = {DEFAULT_VOICE, 'en-US-AndrewMultilingualNeural', 'en-US-AvaMultilingualNeural', 'fil-PH-AngeloNeural', 'fil-PH-BlessicaNeural'}
GREETING = 'Hello. Jarvis here. How can I help?'


def spoken_text(text):
    text = str(text)[:2400]
    text = re.sub(r'```.*?```', ' Code details are in Conclave. ', text, flags=re.S)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    text = re.sub(r'https?://\S+', 'link in Conclave', text)
    text = re.sub(r'[*_`#]', '', text)
    text = ''.join(c for c in text if not unicodedata.category(c).startswith(('C', 'S')) or c in '\n\t')
    return re.sub(r'\s+', ' ', text).strip()


def speech_chunks(text, limit=220):
    text=spoken_text(text)
    chunks=[]
    while len(text)>limit:
        boundary=max(text.rfind('. ',0,limit),text.rfind('? ',0,limit),text.rfind('! ',0,limit))
        cut=boundary+1 if boundary>=40 else text.rfind(' ',0,limit)
        if cut<1:cut=limit
        chunks.append(text[:cut].strip());text=text[cut:].strip()
    if text:chunks.append(text)
    return chunks


async def synthesize(text, path, voice=DEFAULT_VOICE):
    import edge_tts
    if voice not in VOICES:
        raise ValueError('UnsupportedVoice')
    text = spoken_text(text)
    if not text:
        raise ValueError('NoSpeechText')
    # Retry synthesis only, never dialing. The second attempt uses another neural voice.
    fallback = 'en-GB-RyanNeural' if voice != 'en-GB-RyanNeural' else 'en-US-AndrewMultilingualNeural'
    started = time.monotonic()
    for index, chosen in enumerate((voice, fallback)):
        try:
            speech = edge_tts.Communicate(text, chosen, rate='+0%', connect_timeout=4, receive_timeout=6)
            await asyncio.wait_for(speech.save(path), 10)
            if not os.path.getsize(path):
                raise RuntimeError('EmptySpeech')
            return {'attempts': index + 1, 'elapsed_ms': round((time.monotonic() - started) * 1000), 'fallback': bool(index)}
        except asyncio.CancelledError:
            raise
        except Exception:
            if index:
                raise


class SpeechGate:
    """Require sustained energy and recognizable speech, rather than a noise spike."""
    def __init__(self):
        self.voiced = 0.0
        self.last_voice = 0.0

    def feed(self, pcm):
        samples = array('h', pcm[:len(pcm) // 2 * 2])
        rms = math.sqrt(sum(v * v for v in samples) / max(1, len(samples)))
        now = time.monotonic()
        if rms >= 450:
            self.voiced += len(samples) / 16000
            self.last_voice = now
        elif now - self.last_voice > .25:
            self.voiced = 0.0
        return rms

    @staticmethod
    def echo(text, spoken):
        words=re.findall(r'\w+', text.lower());output=set(re.findall(r'\w+', spoken.lower()))
        return len(words)>=3 and sum(w in output for w in words)/len(words)>=.85

    def speaking(self, partial, spoken=''):
        words = re.findall(r'\w+', partial.lower())
        if not words or partial.lower() in {'the', 'a', 'uh', 'um'} or self.voiced < (.08 if words == ['stop'] else .18):
            return False
        # Reject obvious loudspeaker echo, while allowing short commands like "stop".
        if self.echo(partial, spoken):
            return False
        return True


class CallAudio:
    def __init__(self, calls, owner_id, config, lock, reply, model_path=None,
                 notify=lambda state, detail=None: None, text_fallback=None, metric=lambda name, detail: None):
        self.calls, self.owner_id, self.config = calls, owner_id, config
        self.lock, self.reply, self.notify = lock, reply, notify
        self.text_fallback = text_fallback
        self.metric = metric
        self.call_id = uuid.uuid4().hex
        self.turn_index = 0
        self.frames_dropped = 0
        self.output_muted = False
        self.model_path, self.model = model_path, None
        self.stage = 'idle'
        self.session_task = self.recognition_task = self.greeting_task = None
        self.playback = None
        self.closed = asyncio.Event()
        self.interrupted = asyncio.Event()
        self.frames = asyncio.Queue(maxsize=150)
        self.turns = asyncio.Queue(maxsize=4)
        self.speaking = False
        self.last_spoken = ''
        self.tasks = set()

    def _metric(self, name, **detail):
        # Only numerical/categorical diagnostics: no audio, transcript, credentials or paths.
        self.metric(name, {'call_id': self.call_id, 'turn': self.turn_index, **detail})

    async def _model_reply(self, text):
        operation = asyncio.create_task(self.reply(text))
        hangup = asyncio.create_task(self.closed.wait())
        started = time.monotonic()
        outcome = 'cancelled'
        try:
            done, _ = await asyncio.wait([operation, hangup], timeout=100, return_when=asyncio.FIRST_COMPLETED)
            if hangup in done:
                return None
            if operation not in done:
                outcome = 'timeout'
                raise asyncio.TimeoutError()
            result = await operation
            outcome = 'ok'
            return result
        except Exception:
            if outcome != 'timeout': outcome = 'error'
            raise
        finally:
            for task in (operation, hangup):
                if not task.done(): task.cancel()
            await asyncio.gather(operation, hangup, return_exceptions=True)
            self._metric('model', elapsed_ms=round((time.monotonic() - started) * 1000), outcome=outcome)
            # Cancel only the local wait. Backend model/tool work may already be running.

    async def initialize(self):
        from pytgcalls.types import ChatUpdate, StreamFrames, StreamEnded, Direction, Device

        @self.calls.on_update()
        async def update(_, event):
            if event.chat_id != self.owner_id:
                return
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
            elif (isinstance(event, StreamFrames) and event.direction == Direction.INCOMING
                  and getattr(event,'device',Device.MICROPHONE) in (Device.MICROPHONE,getattr(Device,'SPEAKER',Device.MICROPHONE))):
                if self.session_task:
                    # Keep listening during speech and model work so interruption is possible.
                    for frame in event.frames:
                        if self.frames.full():
                            self.frames.get_nowait()
                            self.frames_dropped += 1
                        self.frames.put_nowait(frame.frame)

        if self.config.get('conversation_enabled'):
            if not self.model_path or not os.path.isdir(self.model_path):
                raise RuntimeError('LocalSpeechModelMissing')
            from vosk import Model, SetLogLevel
            SetLogLevel(-1)
            started = time.monotonic()
            self.model = await asyncio.to_thread(Model, self.model_path)
            self._metric('initialization', elapsed_ms=round((time.monotonic() - started) * 1000), outcome='ok')
            self.greeting_task = asyncio.create_task(self._warm_greeting())

    async def _warm_greeting(self):
        started=time.monotonic()
        outcome='cancelled'
        try:
            with tempfile.TemporaryDirectory(prefix='conclave-greeting-') as folder:
                path = os.path.join(folder, 'greeting.mp3')
                await synthesize(GREETING, path, self.config.get('voice', DEFAULT_VOICE))
                with open(path, 'rb') as source:
                    audio=source.read()
                outcome='ok'
                return audio
        except Exception:
            outcome='error'
            return None
        finally:
            self._metric('greeting',elapsed_ms=round((time.monotonic()-started)*1000),outcome=outcome)

    async def _interruptible(self, awaitable):
        operation = asyncio.ensure_future(awaitable)
        interruption = asyncio.create_task(self.interrupted.wait())
        hangup = asyncio.create_task(self.closed.wait())
        try:
            done, _ = await asyncio.wait([operation, interruption, hangup], return_when=asyncio.FIRST_COMPLETED)
            if interruption in done or hangup in done:
                return False, None
            return True, await operation
        finally:
            for task in (operation, interruption, hangup):
                if not task.done():
                    task.cancel()
            await asyncio.gather(operation, interruption, hangup, return_exceptions=True)

    async def interrupt(self):
        if self.interrupted.is_set():
            return
        started = time.monotonic()
        self.interrupted.set()
        outcome = 'ok'
        if self.speaking:
            from pytgcalls.types import MediaStream, ExternalMedia
            try:
                await asyncio.wait_for(self.calls.play(self.owner_id, MediaStream(ExternalMedia.AUDIO)), 3)
            except Exception as error:
                # Mute outgoing audio if stream replacement fails; leave capture running.
                try:
                    await asyncio.wait_for(self.calls.mute(self.owner_id), 2)
                    self.output_muted = True
                    outcome = 'fallback'
                except Exception:
                    outcome = 'error'
                    self.notify('interruption_failed', {'stage': 'interruption', 'error': type(error).__name__})
        if outcome != 'error': self.notify('interrupted')
        self._metric('interruption', elapsed_ms=round((time.monotonic() - started) * 1000), outcome=outcome)

    async def say(self, text):
        from pytgcalls.types import MediaStream
        if self.interrupted.is_set() or self.closed.is_set():
            return False
        self.notify('speaking')
        self.speaking = True
        self.last_spoken = spoken_text(text)
        started = time.monotonic()
        outcome = 'cancelled'
        stream_ready_ms = None
        preparing = None
        temporary = None
        try:
            chunks=speech_chunks(text)
            if not chunks:raise ValueError('NoSpeechText')
            temporary = tempfile.TemporaryDirectory(prefix='conclave-neural-')
            folder = temporary.name
            async def prepare(index):
                path=os.path.join(folder,f'speech-{index}.mp3')
                cached=None
                if text==GREETING and index==0 and self.greeting_task and self.greeting_task.done() and not self.greeting_task.cancelled():
                    cached=self.greeting_task.result()
                if cached:
                    with open(path,'wb') as output:output.write(cached)
                else:
                    synthesis_started = time.monotonic()
                    synthesis_outcome = 'cancelled'
                    stats = None
                    try:
                        stats = await synthesize(chunks[index],path,self.config.get('voice',DEFAULT_VOICE))
                        synthesis_outcome = 'ok'
                    except Exception:
                        synthesis_outcome = 'error'
                        raise
                    finally:
                        self._metric('synthesis', elapsed_ms=round((time.monotonic()-synthesis_started)*1000),
                                     outcome=synthesis_outcome, attempts=stats.get('attempts',1) if isinstance(stats,dict) else 1,
                                     fallback=stats.get('fallback',False) if isinstance(stats,dict) else False)
                return path
            preparing=asyncio.create_task(prepare(0))
            for index in range(len(chunks)):
                ok,path=await self._interruptible(preparing)
                preparing=None
                if not ok:return False
                # Prefetch one next chunk while this chunk plays; never launch all at once.
                if index+1<len(chunks):preparing=asyncio.create_task(prepare(index+1))
                self.playback=asyncio.Event()
                if self.output_muted:
                    await self.calls.unmute(self.owner_id)
                    self.output_muted = False
                with contextlib.redirect_stdout(__import__('sys').stderr):
                    ok,_=await self._interruptible(asyncio.wait_for(self.calls.play(self.owner_id,MediaStream(path)),45))
                if not ok:return False
                if stream_ready_ms is None:stream_ready_ms=round((time.monotonic()-started)*1000)
                ok,_=await self._interruptible(asyncio.wait_for(self.playback.wait(),180))
                if not ok:return False
            outcome = 'ok'
            return True
        except Exception:
            outcome = 'error'
            raise
        finally:
            self._metric('playback', elapsed_ms=round((time.monotonic()-started)*1000), outcome=outcome,
                         **({'stream_ready_ms':stream_ready_ms} if stream_ready_ms is not None else {}))
            if preparing:
                preparing.cancel()
                await asyncio.gather(preparing,return_exceptions=True)
            if temporary:temporary.cleanup()
            self.playback=None
            self.speaking=False
            # Preserve incoming interruption audio for the continuous recognizer.

    async def safe_say(self, text):
        try:
            return await self.say(text)
        except Exception as error:
            if self.closed.is_set() or self.interrupted.is_set():
                return False
            self.notify('speech_unavailable', {'stage': self.stage, 'error': type(error).__name__})
            if self.text_fallback:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(self.text_fallback(text), 10)
                    self.notify('text_fallback')
            return False

    async def _recognize(self):
        from vosk import KaldiRecognizer
        recognizer = None
        gate = SpeechGate()
        partial, size, overlap, partial_at = '', 0, False, 0.0
        window_started = time.monotonic()
        window_count = window_bytes = 0
        rms_sum = rms_peak = 0.0
        rms_min = 32768.0
        def flush_metrics(force=False):
            nonlocal window_started, window_count, window_bytes, rms_sum, rms_peak, rms_min
            if window_count and (force or time.monotonic()-window_started >= 5):
                self._metric('recognition_window', elapsed_ms=round((time.monotonic()-window_started)*1000),
                             rms_min=round(rms_min,2),rms_mean=round(math.sqrt(rms_sum/max(1,window_bytes)),2),rms_max=round(rms_peak,2),
                             chunks=window_count,bytes=window_bytes,threshold_rms=450,queue_depth=self.frames.qsize(),
                             dropped_frames=self.frames_dropped)
                window_started=time.monotonic();window_count=window_bytes=0
                rms_sum=rms_peak=0.0;rms_min=32768.0
        def paused():
            last_progress=max(gate.last_voice,partial_at)
            return bool(partial and last_progress and time.monotonic()-last_progress>.65)
        async def queue_text(text):
            if not text or overlap and SpeechGate.echo(text,self.last_spoken):
                return
            if (self.speaking or self.stage=='thinking') and gate.speaking(text,self.last_spoken if self.speaking else ''):
                await self.interrupt()
            if not self.turns.full():
                self.turns.put_nowait(text[:2000])
                self._metric('recognition_turn', chars=min(len(text),2000),queue_depth=self.turns.qsize(),outcome='ok')
        async def finish():
            nonlocal recognizer, gate, partial, size, overlap, partial_at
            raw = await asyncio.to_thread(recognizer.FinalResult)
            text = json.loads(raw).get('text', '').strip()
            await queue_text(text)
            recognizer = KaldiRecognizer(self.model, 16000)
            gate, partial, size, overlap, partial_at = SpeechGate(), '', 0, False, 0.0
        try:
            recognizer = KaldiRecognizer(self.model, 16000)
            while not self.closed.is_set():
                try:
                    chunk = await asyncio.wait_for(self.frames.get(), .1)
                except asyncio.TimeoutError:
                    if paused():
                        await finish()
                    flush_metrics()
                    continue
                while not self.frames.empty() and len(chunk) < 6400:
                    chunk += self.frames.get_nowait()
                overlap = overlap or self.speaking
                rms = gate.feed(chunk)
                window_count += 1;window_bytes += len(chunk)
                rms_sum += rms*rms*len(chunk);rms_peak=max(rms_peak,rms);rms_min=min(rms_min,rms)
                flush_metrics()
                size += len(chunk)
                complete = await asyncio.to_thread(recognizer.AcceptWaveform, chunk)
                next_partial = json.loads(await asyncio.to_thread(recognizer.PartialResult)).get('partial', '')
                if next_partial and next_partial != partial:partial_at=time.monotonic()
                partial = next_partial
                if (self.speaking or self.stage == 'thinking') and gate.speaking(partial, self.last_spoken if self.speaking else ''):
                    await self.interrupt()
                if complete:
                    text = json.loads(await asyncio.to_thread(recognizer.Result)).get('text', '').strip()
                    await queue_text(text)
                    recognizer = KaldiRecognizer(self.model, 16000)
                    gate, partial, size, overlap, partial_at = SpeechGate(), '', 0, False, 0.0
                elif paused() or size >= 640000:
                    await finish()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.notify('error', {'stage': 'recognition', 'error': type(error).__name__})
            self.closed.set()
        finally:
            flush_metrics(force=True)

    async def listen(self, recognizer=None):
        if self.recognition_task:
            turn=asyncio.create_task(self.turns.get());hangup=asyncio.create_task(self.closed.wait())
            try:
                done,_=await asyncio.wait([turn,hangup],timeout=45,return_when=asyncio.FIRST_COMPLETED)
                if hangup in done:return ''
                if turn in done:return turn.result()
                raise asyncio.TimeoutError()
            finally:
                for task in (turn,hangup):task.cancel()
                await asyncio.gather(turn,hangup,return_exceptions=True)
        # Kept for isolated recognizer tests; production uses the continuous pipeline.
        async def consume():
            while not self.closed.is_set():
                chunk = await self.frames.get()
                if await asyncio.to_thread(recognizer.AcceptWaveform, chunk):
                    text = json.loads(recognizer.Result()).get('text', '').strip()
                    if text:
                        return text[:2000]
            return ''
        return await asyncio.wait_for(consume(), 45)

    async def converse(self):
        from pytgcalls.types import RecordStream, MediaStream, ExternalMedia
        from pytgcalls.types.raw import AudioParameters
        failed = False
        call_started = time.monotonic()
        self.call_id=uuid.uuid4().hex
        self.turn_index=self.frames_dropped=0
        try:
            async with self.lock:
                self.stage = 'connecting'
                self.notify('connecting')
                self.closed.clear()
                self.interrupted.clear()
                await asyncio.wait_for(self.calls.play(self.owner_id, MediaStream(ExternalMedia.AUDIO)), 30)
                self.stage = 'recording'
                await self.calls.record(self.owner_id, RecordStream(audio=True, audio_parameters=AudioParameters(bitrate=16000, channels=1)))
                self.recognition_task = asyncio.create_task(self._recognize())
                self.stage = 'greeting'
                await self.safe_say(GREETING)
                async with asyncio.timeout(600):
                    while not self.closed.is_set():
                        self.stage = 'listening'
                        self.notify('listening')
                        try:
                            text = await self.listen()
                        except asyncio.TimeoutError:
                            break
                        if not text or self.closed.is_set():
                            break
                        self.turn_index += 1
                        self.interrupted.clear()
                        if text in ('goodbye', 'bye jarvis', 'hang up', 'end call', 'stop call'):
                            await self.safe_say('Goodbye.'); break
                        if text in ('stop', 'wait', 'pause'):
                            continue
                        self.stage = 'thinking'
                        self.notify('thinking')
                        answer = await self._model_reply(text)
                        # Let a queued interruption supersede speech for the previous turn.
                        if answer is not None and not self.closed.is_set() and not self.interrupted.is_set():
                            self.stage = 'speaking'
                            await self.safe_say(answer)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failed = True
            self.notify('error', {'stage': self.stage, 'error': type(error).__name__})
        finally:
            self._metric('call',elapsed_ms=round((time.monotonic()-call_started)*1000),outcome='error' if failed else 'closed')
            if self.recognition_task:
                self.recognition_task.cancel()
                await asyncio.gather(self.recognition_task, return_exceptions=True)
                self.recognition_task = None
            if not failed:
                self.notify('closed')
            self.closed.set()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.calls.leave_call(self.owner_id), 10)
            self.session_task = None
            for queue in (self.frames, self.turns):
                while not queue.empty():
                    queue.get_nowait()

    async def close(self):
        self.closed.set()
        for task in list(self.tasks):
            task.cancel()
        if self.greeting_task:
            self.greeting_task.cancel()
        await asyncio.gather(*self.tasks, *([self.greeting_task] if self.greeting_task else []), return_exceptions=True)
