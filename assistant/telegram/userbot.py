"""Private JSON-lines bridge. Credentials arrive on stdin, never argv or logs."""
import asyncio
import contextlib
import json
import logging
import os
import sys
import tempfile

logging.disable(logging.CRITICAL)
PROTOCOL = sys.stdout

def emit(value):
    PROTOCOL.write(json.dumps(value) + '\n')
    PROTOCOL.flush()

def prompt(label, secret=False):
    if secret:
        import getpass
        return getpass.getpass(label)
    print(label, end='', file=sys.stderr, flush=True)
    return input()

async def enroll():
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    # App credentials stay outside the repository; session authorization is interactive.
    app_file = os.environ.get('CONCLAVE_TELEGRAM_APP_FILE', os.path.expanduser('~/.config/conclave/telegram-app.json'))
    app = {}
    if os.path.isfile(app_file):
        if os.stat(app_file).st_mode & 0o077:
            raise RuntimeError('AppCredentialsMustBePrivate')
        with open(app_file, encoding='utf-8') as source:
            app = json.load(source)
    api_id = int(app['api_id'] if app.get('api_id') else prompt('Telegram API ID: '))
    api_hash = app.get('api_hash') or prompt('API hash (hidden): ', True)
    owner_id = int(prompt('Your Telegram numeric user ID (allowed owner): '))
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.start(phone=lambda: prompt('Userbot phone number: '),
                       code_callback=lambda: prompt('Login code (hidden): ', True),
                       password=lambda: prompt('Two-step password (hidden): ', True))
    result = dict(api_id=api_id, api_hash=api_hash, owner_id=owner_id,
                  session=client.session.save(), enabled=False,
                  calls_enabled=False, notifications=False)
    await client.disconnect()
    emit(result)

async def login():
    """Browser login over JSON lines. Phone, code and password arrive on stdin only and are never
    written anywhere; the only durable output is the StringSession emitted on success."""
    from telethon import TelegramClient, errors
    from telethon.sessions import StringSession
    async def read():
        line = await asyncio.wait_for(asyncio.to_thread(sys.stdin.readline), timeout=600)
        if not line:
            raise RuntimeError('LoginCancelled')
        return json.loads(line)
    first = await read()
    client = TelegramClient(StringSession(), int(first['api_id']), first['api_hash'], connection_retries=2)
    await client.connect()
    try:
        phone = str(first['phone'])
        try:
            await client.send_code_request(phone)
        except (errors.PhoneNumberInvalidError, errors.PhoneNumberBannedError, errors.PhoneNumberFloodError, errors.FloodWaitError, errors.ApiIdInvalidError) as error:
            emit({'step': 'error', 'error': type(error).__name__}); return
        emit({'step': 'code'})
        attempts = 0
        while True:
            message = await read()
            try:
                if 'password' in message:
                    await client.sign_in(password=str(message['password']))
                else:
                    await client.sign_in(phone=phone, code=str(message.get('code', '')))
                break
            except errors.SessionPasswordNeededError:
                emit({'step': 'password'})
            except (errors.PhoneCodeInvalidError, errors.PasswordHashInvalidError) as error:
                attempts += 1
                if attempts >= 5:
                    emit({'step': 'error', 'error': 'TooManyAttempts'}); return
                emit({'step': 'password' if 'password' in message else 'code', 'error': type(error).__name__})
            except (errors.PhoneCodeExpiredError, errors.FloodWaitError) as error:
                emit({'step': 'error', 'error': type(error).__name__}); return
        me = await client.get_me()
        emit({'step': 'done', 'session': client.session.save(), 'account_id': me.id})
    finally:
        await client.disconnect()

async def serve():
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    raw = await asyncio.to_thread(sys.stdin.readline)
    config = json.loads(raw)
    client = TelegramClient(StringSession(config['session']), int(config['api_id']), config['api_hash'], connection_retries=2)
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError('AuthorizationRequired')
    own = await client.get_me()
    owner = await client.get_entity(int(config['owner_id']))
    if not getattr(owner, 'id', None) or owner.id != int(config['owner_id']):
        raise RuntimeError('OwnerNotResolved')
    calls = None
    call_audio = None
    voice_replies = {}
    call_lock = asyncio.Lock()

    async def voice_reply(text):
        import uuid
        turn_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        voice_replies[turn_id] = future
        emit({'event':'voice_turn','turn_id':turn_id,'text':text})
        try:
            return await asyncio.wait_for(future, 95)
        finally:
            voice_replies.pop(turn_id, None)

    async def text_fallback(text):
        await client.send_message(owner, '[Conclave] Voice reply (speech unavailable): ' + str(text)[:3600], parse_mode=None)

    async def init_calls():
        nonlocal calls, call_audio
        if calls is not None:
            return
        from pytgcalls import PyTgCalls
        from call_audio import CallAudio
        with contextlib.redirect_stdout(sys.stderr):
            calls = PyTgCalls(client)
            await calls.start()
            call_audio = CallAudio(calls, owner.id, config, call_lock, voice_reply, os.environ.get('TELEGRAM_STT_MODEL'), notify=lambda state, detail=None: emit({'event':'voice_state','state':state,**(detail or {})}), text_fallback=text_fallback)
            await call_audio.initialize()

    if config.get('conversation_enabled') and config.get('calls_enabled') and own.id != owner.id:
        await init_calls()
    emit({'ready': True, 'account_id': own.id, 'self_chat': own.id == owner.id})

    async def handle(request):
        nonlocal calls
        request_id = request.get('id')
        try:
            op = request['op']
            if op == 'voice_answer':
                future = voice_replies.get(request.get('turn_id'))
                if future and not future.done():
                    future.set_result(str(request.get('text', 'I could not prepare a reply.'))[:2400])
                emit({'id':request_id,'result':{'ok':True}})
                return
            if op == 'poll':
                after = int(request.get('after', 0))
                messages = [m async for m in client.iter_messages(owner, limit=50, min_id=after, reverse=after > 0)]
                result = []
                for message in sorted(messages, key=lambda m: m.id):
                    text = message.raw_text or ''
                    if message.sender_id != owner.id or text.startswith('[Conclave]'):
                        continue
                    if own.id == owner.id and not text.startswith('/conclave '):
                        continue
                    if own.id != owner.id and message.out:
                        continue
                    if text.startswith('/conclave '):
                        text = text[len('/conclave '):]
                    if text.strip():
                        result.append({'id': message.id, 'text': text[:12000]})
                emit({'id': request_id, 'result': {'messages': result, 'latest': max([m.id for m in messages], default=int(request.get('after', 0)))}})
                return
            if op == 'send':
                text = '[Conclave] ' + str(request['text'])[:3800]
                sent = await client.send_message(owner, text, parse_mode=None)
                emit({'id': request_id, 'result': {'message_id': sent.id}})
                return
            if op == 'call':
                if not config.get('calls_enabled') or own.id == owner.id:
                    raise RuntimeError('CallsNeedSeparateAccountAndPermission')
                if call_lock.locked():
                    raise RuntimeError('CallAlreadyRunning')
                async with call_lock:
                    await init_calls()
                    call_audio.closed.clear()
                    try:
                        await call_audio.say(str(request['text'])[:800])
                    finally:
                        with contextlib.suppress(Exception):
                            await asyncio.wait_for(calls.leave_call(owner.id), 10)
                    emit({'id': request_id, 'result': {'completed': True}})
                    return
            raise RuntimeError('UnknownOperation')
        except Exception as error:
            # Error type only; provider exception messages can contain private data.
            emit({'id': request_id, 'error': type(error).__name__})

    pending = set()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            if len(line) > 65536:
                continue
            task = asyncio.create_task(handle(json.loads(line)))
            pending.add(task)
            task.add_done_callback(pending.discard)
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if call_audio:
            await call_audio.close()
        await client.disconnect()

if __name__ == '__main__':
    try:
        asyncio.run(enroll() if '--enroll' in sys.argv else login() if '--login' in sys.argv else serve())
    except Exception as error:
        emit({'fatal': type(error).__name__})
        sys.exit(1)
