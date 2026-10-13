import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const tokenHash = value => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 32);
  return `${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const actual = await derive(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}
export function issueToken(store, userId) {
  const token = randomBytes(32).toString('base64url');
  store.createToken(tokenHash(token), userId);
  return token;
}
export function requestToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('pi_session='))?.slice(11);
}
