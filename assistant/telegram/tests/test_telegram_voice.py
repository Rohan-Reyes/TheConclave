import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from telegram_voice import Settings, TelegramVoice


class FakeBackend:
    def __init__(self):
        self.started = self.closed = False
        self.events = []
        self.paths = []
        self.active = 0
        self.max_active = 0
        self.gate = asyncio.Event()
        self.gate.set()

    async def start(self):
        self.started = True

    async def play(self, chat_id, path):
        self.paths.append(path)
        self.active += 1
        self.max_active = max(self.active, self.max_active)
        try:
            await self.gate.wait()
            text = Path(path).read_text()
            self.events.append(text)
            if text == 'fail':
                raise RuntimeError('private provider error')
            await asyncio.sleep(0)
        finally:
            self.active -= 1

    async def close(self):
        self.closed = True


async def synth(text, path, voice):
    Path(path).write_text(text)
    await asyncio.sleep(0)


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.backend = FakeBackend()
        self.voice = TelegramVoice(Settings(123, 'hash', 'session', -100123),
                                   backend=self.backend, synthesize=synth)
        await self.voice.start()

    async def asyncTearDown(self):
        await self.voice.close(drain=False)

    async def test_sequential_delivery_and_files_removed(self):
        receipts = [await self.voice.enqueue_call(-100123, str(i)) for i in range(4)]
        results = await asyncio.gather(*receipts)
        self.assertTrue(all(r.success for r in results))
        self.assertEqual(self.backend.events, ['0', '1', '2', '3'])
        self.assertEqual(self.backend.max_active, 1)
        self.assertTrue(all(not Path(p).exists() for p in self.backend.paths))

    async def test_failure_does_not_kill_queue_or_leak_error_text(self):
        first = await self.voice.enqueue_call(-100123, 'fail')
        second = await self.voice.enqueue_call(-100123, 'recover')
        self.assertEqual((await first).error, 'RuntimeError')
        self.assertTrue((await second).success)

    async def test_enqueue_does_not_wait_for_playback(self):
        self.backend.gate.clear()
        receipt = await asyncio.wait_for(self.voice.enqueue_call(-100123, 'hello'), 0.1)
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertFalse(receipt.done())
        self.backend.gate.set()
        self.assertTrue((await receipt).success)

    async def test_shutdown_cancels_and_cleans_active_and_pending(self):
        self.backend.gate.clear()
        receipts = [await self.voice.enqueue_call(-100123, str(i)) for i in range(3)]
        for _ in range(10):
            await asyncio.sleep(0)
        await self.voice.close(drain=False)
        self.assertTrue(all(r.cancelled() for r in receipts))
        self.assertTrue(self.backend.closed)
        self.assertTrue(all(not Path(p).exists() for p in self.backend.paths))
        await asyncio.wait_for(self.voice.queue.join(), 0.1)
        with self.assertRaises(RuntimeError):
            await self.voice.enqueue_call(-100123, 'closed')

    async def test_full_queue_and_invalid_target(self):
        self.voice.queue = asyncio.Queue(maxsize=1)
        await self.voice.enqueue_call(-100123, 'first')
        with self.assertRaises(asyncio.QueueFull):
            await self.voice.enqueue_call(-100123, 'second')
        for target, text in [(123, 'hello'), (-100123, ''), (-100123, 'x' * 4001)]:
            with self.assertRaises(ValueError):
                await self.voice.enqueue_call(target, text)

    async def test_timeout_cleans_and_worker_recovers(self):
        self.voice.alert_timeout = 0.02
        self.backend.gate.clear()
        receipt = await self.voice.enqueue_call(-100123, 'timeout')
        self.assertEqual((await receipt).error, 'TimeoutError')
        self.backend.gate.set()
        receipt = await self.voice.enqueue_call(-100123, 'next')
        self.assertTrue((await receipt).success)
        self.assertTrue(all(not Path(p).exists() for p in self.backend.paths))

    async def test_credentials_not_in_repr(self):
        self.assertNotIn('session', repr(self.voice.settings))
        self.assertNotIn('hash', repr(self.voice.settings))


if __name__ == '__main__':
    unittest.main()
