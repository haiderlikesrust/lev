import { createHash, randomBytes, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { httpError } from './redact';
import type { Database } from './db';
import { APP_NAME } from '../shared/brand';

// Ported from Pullback (server/auth.ts): Sign-In With Solana, then an httpOnly session cookie.
export const SESSION_COOKIE = 'lev_session';
export const hashSession = (token: string) => createHash('sha256').update(token).digest('hex');

export async function challenge(db: Database, wallet: string) {
  try { new PublicKey(wallet); } catch { throw httpError(400, 'That is not a Solana wallet address.'); }
  const id = randomUUID(), now = Date.now(), expiresAt = now + 300_000;
  const origin = new URL(config.APP_ORIGIN);
  const message = `${origin.host} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to ${APP_NAME}. This does not authorize a transaction.\n\nURI: ${origin.origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${randomBytes(16).toString('hex')}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
  await db.query('INSERT INTO challenges(id,wallet,message,expires_at) VALUES($1,$2,$3,$4)', [id, wallet, message, expiresAt]);
  return { id, message, expiresAt };
}

export async function verify(db: Database, id: string, signature: string) {
  const row = (await db.query('SELECT * FROM challenges WHERE id=$1 AND consumed=FALSE AND expires_at>$2', [id, Date.now()])).rows[0];
  if (!row) throw httpError(401, 'This sign-in request expired or was already used.');
  let valid = false;
  try { valid = nacl.sign.detached.verify(new TextEncoder().encode(row.message), bs58.decode(signature), new PublicKey(row.wallet).toBytes()); } catch {}
  if (!valid) throw httpError(401, 'Wallet signature is invalid.');
  const consumed = await db.query('UPDATE challenges SET consumed=TRUE WHERE id=$1 AND consumed=FALSE RETURNING id', [id]);
  if (!consumed.rows.length) throw httpError(401, 'Sign-in request was already used.');
  return createSession(db, row.wallet);
}

export async function createSession(db: Database, wallet: string) {
  const now = Date.now();
  await db.query('INSERT INTO wallets(wallet,activated_at,last_seen_at) VALUES($1,$2,$2) ON CONFLICT(wallet) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at', [wallet, now]);
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions(id,wallet,expires_at) VALUES($1,$2,$3)', [hashSession(token), wallet, now + 86_400_000]);
  return { token, wallet };
}

export async function sessionWallet(db: Database, token?: string | null) {
  if (!token) return null;
  const row = (await db.query('SELECT s.wallet FROM sessions s WHERE s.id=$1 AND s.expires_at>$2', [hashSession(token), Date.now()])).rows[0];
  if (!row) return null;
  const wallet = row.wallet as string;
  // Practice mode has no owner wallet unless one is set, so anyone can try the admin page there.
  return { wallet, owner: config.OWNER_WALLET ? wallet === config.OWNER_WALLET : !config.live };
}

export async function endSession(db: Database, token?: string | null) {
  if (token) await db.query('DELETE FROM sessions WHERE id=$1', [hashSession(token)]);
}
