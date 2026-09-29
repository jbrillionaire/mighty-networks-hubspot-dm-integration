/**
 * oauth.js -- Mighty Networks OAuth 2.0 Authorization Code + PKCE
 * ---------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Server side or local only. Never in a browser bundle when the
 *          application is Confidential: the client secret travels in these
 *          requests.
 *
 * What it does:
 *   Builds the authorize URL (with PKCE and state), exchanges the returned
 *   code for tokens, refreshes tokens, and stores them in a local JSON file.
 *
 * Why it exists:
 *   The Mighty API has no static API key. Every GraphQL call needs a
 *   short-lived (about 1 hour) OAuth token that acts as one real person.
 *   A DM is sent AS that person, so this is the account your members see.
 *
 * Constraints that silently break things if changed:
 *   - Refresh tokens can ROTATE. saveTokens() must run after every refresh or
 *     the next refresh fails with invalid_grant and you must re-authorize.
 *   - write:chats always shows the consent screen, even on apps set to skip
 *     it. There is no fully headless first authorization; do it once by hand.
 *   - Any host:* scope means only Network Hosts can finish sign-in.
 *   - Confidential clients fall back to HTTP Basic client authentication when
 *     body credentials get a 401 (seen in production).
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createState() {
  return b64url(randomBytes(32));
}

export function buildAuthorizeUrl(config, { state, challenge }) {
  const url = new URL(`${config.oauthBase}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function tokenRequest(config, params, fetchImpl = fetch) {
  const post = (useBasic) => {
    const body = new URLSearchParams({ ...params });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.userAgent };
    if (useBasic) {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_id', config.clientId);
      if (config.clientSecret) body.set('client_secret', config.clientSecret); // public clients must NOT send one
    }
    return fetchImpl(`${config.oauthBase}/token`, { method: 'POST', headers, body });
  };
  // Mighty's token endpoint has answered invalid_client (401) to credentials in the
  // body; the same credentials as HTTP Basic then worked. Confidential clients retry.
  let res = await post(false);
  if (res.status === 401 && config.clientSecret) res = await post(true);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.access_token) {
    const code = json?.error || `http_${res.status}`;
    const err = new Error(`Token request failed: ${code}${json?.error_description ? ` (${json.error_description})` : ''}`);
    err.code = code;
    throw err;
  }
  // Store an absolute expiry so a restart knows whether the token is still good.
  return { ...json, expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
}

export function exchangeCode(config, { code, verifier }, fetchImpl) {
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  }, fetchImpl);
}

export async function refreshTokens(config, tokens, fetchImpl) {
  if (!tokens?.refresh_token) throw Object.assign(new Error('No refresh token stored. Run: npm run authorize'), { code: 'invalid_grant' });
  const fresh = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, fetchImpl);
  // Keep the old refresh token only if Mighty did not rotate it.
  return { ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token };
}

export function loadTokens(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export function saveTokens(file, tokens) {
  writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

/** True when the token expires within the next 2 minutes (or has no expiry). */
export function isExpiring(tokens, now = Date.now()) {
  return !tokens?.expires_at || tokens.expires_at - now < 120_000;
}
