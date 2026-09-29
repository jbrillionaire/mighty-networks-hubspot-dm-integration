/**
 * authorize.js -- one-time OAuth sign-in for the sending account
 * --------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Run on your own machine: `npm run authorize`. Sign in as the Host
 *          account that DMs should come FROM. Not for servers without a browser.
 *
 * What it does:
 *   Starts a tiny HTTP server on the port in MIGHTY_REDIRECT_URI, prints the
 *   Mighty consent URL, waits for the redirect, checks `state`, exchanges the
 *   code (with the PKCE verifier) and saves tokens to MIGHTY_TOKEN_FILE.
 *
 * Why it exists:
 *   write:chats always forces the consent screen, so the first token has to
 *   come from a person clicking Approve. After that, refresh tokens keep the
 *   scripts running unattended until the refresh token expires or is revoked.
 *
 * Only http://localhost redirect URIs work with this script. Mighty accepts
 * plain http only for localhost; anything else must be https.
 */

import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { buildAuthorizeUrl, createPkcePair, createState, exchangeCode, saveTokens } from '../src/oauth.js';

const config = loadConfig();
if (!config.clientId) throw new Error('MIGHTY_CLIENT_ID is not set.');

const redirect = new URL(config.redirectUri);
if (redirect.hostname !== 'localhost' && redirect.hostname !== '127.0.0.1') {
  throw new Error(`This script needs a localhost redirect URI; got ${config.redirectUri}.`);
}

const { verifier, challenge } = createPkcePair();
const state = createState();
const authorizeUrl = buildAuthorizeUrl(config, { state, challenge });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, config.redirectUri);
  if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }

  const finish = (code, msg) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
    server.close();
  };

  if (url.searchParams.get('error')) {
    finish(400, `Authorization failed: ${url.searchParams.get('error')}`);
    console.error(`Authorization failed: ${url.searchParams.get('error')} ${url.searchParams.get('error_description') ?? ''}`);
    process.exitCode = 1;
    return;
  }
  // CSRF defense: never exchange a code whose state we did not issue.
  if (url.searchParams.get('state') !== state) {
    finish(400, 'State mismatch. Start again with npm run authorize.');
    console.error('State mismatch: refusing to exchange the code.');
    process.exitCode = 1;
    return;
  }

  try {
    const tokens = await exchangeCode(config, { code: url.searchParams.get('code'), verifier });
    saveTokens(config.tokenFile, tokens);
    finish(200, 'Authorized. You can close this tab.');
    console.log(`Saved tokens to ${config.tokenFile}`);
    console.log(`Granted scopes: ${tokens.scope}`);
    if (!/write:chats/.test(tokens.scope ?? '')) console.warn('WARNING: write:chats was not granted, so sending DMs will fail.');
    console.log('Next: npm run whoami');
  } catch (err) {
    finish(500, `Token exchange failed: ${err.message}`);
    console.error(err.message);
    process.exitCode = 1;
  }
});

server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
  console.log('Open this URL, sign in as the Host account DMs should come from, and approve:\n');
  console.log(authorizeUrl + '\n');
  console.log(`Waiting for the redirect on ${config.redirectUri} ...`);
});
