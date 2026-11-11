import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { credential, passwordMatches } from './security.js';
import { audit, transaction } from './db.js';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export async function handlePasskeys(db, path, b, origin, session, method = 'POST') {
  const rpID = new URL(origin).hostname;
  if (/^[\d.]+$/.test(rpID) && path !== '/api/passkeys') fail('Passkeys require a domain RP ID. Use localhost for local development or the configured HTTPS domain.');
  db.prepare('DELETE FROM challenges WHERE expires<?').run(Date.now());
  if (path === '/api/passkeys' && session && method === 'GET') return db.prepare('SELECT id,name,created_at FROM passkeys').all();
  if (path.startsWith('/api/passkeys/') && session && method === 'DELETE') {
    db.prepare('DELETE FROM passkeys WHERE id=?').run(decodeURIComponent(path.split('/').at(-1))); audit(db, 'passkey.deleted'); return { ok: true };
  }
  if (method !== 'POST') fail('Method not allowed');
  if (path === '/api/passkeys/register/options' && session) {
    const owner = db.prepare('SELECT * FROM owner').get();
    if (!passwordMatches(b.password, owner.password)) fail('Current password required to enroll a passkey');
    const options = await generateRegistrationOptions({ rpName: 'Jarvis', rpID, userName: owner.username, userID: new Uint8Array(Buffer.from('jarvis-owner')), attestationType: 'none', supportedAlgorithmIDs: [-7,-257,-8], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: db.prepare('SELECT id FROM passkeys').all() });
    db.prepare('INSERT OR REPLACE INTO challenges VALUES(?,?,?,?)').run(session, options.challenge, 'registration', Date.now() + 300_000);
    return { options };
  }
  if (path === '/api/passkeys/register/verify' && session) {
    const challenge = db.prepare("DELETE FROM challenges WHERE id=? AND purpose='registration' RETURNING *").get(session);
    if (!challenge) fail('Registration expired');
    let result; try { result = await verifyRegistrationResponse({ response: b.response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); } catch { fail('Passkey verification failed'); }
    if (!result.verified) fail('Passkey verification failed');
    const c = result.registrationInfo.credential;
    db.prepare('INSERT INTO passkeys VALUES(?,?,?,?,?,?)').run(c.id, Buffer.from(c.publicKey).toString('base64'), c.counter, JSON.stringify(c.transports || []), String(b.name || 'Passkey').slice(0, 100), Date.now());
    audit(db, 'passkey.registered'); return { ok: true };
  }
  if (path === '/api/passkeys/login/options') {
    // Keep outstanding anonymous challenges bounded without revealing owner credentials.
    if (db.prepare("SELECT count(*) AS n FROM challenges WHERE purpose='authentication'").get().n > 100) fail('Too many pending sign-ins; try again later');
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const challengeId = credential();
    db.prepare('INSERT INTO challenges VALUES(?,?,?,?)').run(challengeId, options.challenge, 'authentication', Date.now() + 120_000);
    return { options, challenge_id: challengeId };
  }
  if (path === '/api/passkeys/login/verify') {
    const challenge = db.prepare("DELETE FROM challenges WHERE id=? AND purpose='authentication' RETURNING *").get(String(b.challenge_id || ''));
    const stored = db.prepare('SELECT * FROM passkeys WHERE id=?').get(String(b.response?.id || ''));
    if (!challenge || !stored) fail('Passkey sign-in expired or invalid');
    let result; try {
      result = await verifyAuthenticationResponse({ response: b.response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: stored.id, publicKey: new Uint8Array(Buffer.from(stored.public_key, 'base64')), counter: stored.counter, transports: JSON.parse(stored.transports) }, requireUserVerification: true });
    } catch { fail('Passkey authentication failed'); }
    if (!result.verified) fail('Passkey authentication failed');
    transaction(db, () => {
      const updated = db.prepare('UPDATE passkeys SET counter=? WHERE id=? AND counter=?').run(result.authenticationInfo.newCounter, stored.id, stored.counter);
      if (!updated.changes) fail('Concurrent passkey sign-in; retry');
      audit(db, 'passkey.authenticated');
    }); return { authenticated: true };
  }
  fail('Unknown passkey operation');
}
