import { randomBytes, scryptSync, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';

export function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Password must contain 12–1024 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [salt, hash] = encoded.split(':');
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
export function sessionHash(token, secret) { return createHmac('sha256', secret).update(token).digest('hex'); }
export const credential = () => randomBytes(32).toString('base64url');
export function encrypt(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64')).join('.');
}
export function decrypt(value, key) {
  const [iv, tag, ciphertext] = value.split('.').map(b => Buffer.from(b, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
