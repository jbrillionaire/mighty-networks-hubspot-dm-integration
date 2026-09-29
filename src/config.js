/**
 * config.js -- load settings from the environment (and an optional .env file)
 * ---------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Imported by the scripts in scripts/. Runs locally or on a server
 *          you control. Never ship this, or anything that reads .env, to a
 *          browser: the client secret and tokens would be public.
 *
 * What it does:
 *   Reads MIGHTY_* settings from process.env, filling gaps from a .env file in
 *   the working directory, and derives the endpoint URLs from the subdomain.
 *
 * Why it exists:
 *   Mighty serves OAuth from <subdomain>.mn.co but GraphQL from api.mn.co.
 *   Putting a custom domain in the wrong one fails with an unhelpful 404, so
 *   both URLs are built from one setting in one place.
 *
 * No dotenv dependency on purpose: the parser below handles KEY=value lines,
 * # comments and optional quotes, which is all .env.example uses.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig({ env = process.env, envFile = '.env' } = {}) {
  const fileVars = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, 'utf8')) : {};
  const get = (k, fallback = '') => (env[k] ?? fileVars[k] ?? fallback).trim();

  const network = get('MIGHTY_NETWORK');
  if (!network) throw new Error('MIGHTY_NETWORK is not set. Copy .env.example to .env and fill it in.');
  if (network.includes('.') || network.includes('/')) {
    throw new Error(`MIGHTY_NETWORK must be the bare mn.co subdomain (e.g. "my-community"), not "${network}".`);
  }

  return {
    network,
    clientId: get('MIGHTY_CLIENT_ID'),
    clientSecret: get('MIGHTY_CLIENT_SECRET'),
    redirectUri: get('MIGHTY_REDIRECT_URI', 'http://localhost:3000/oauth/callback'),
    scopes: get('MIGHTY_SCOPES', 'read:userinfo write:chats host:read:network_members'),
    userAgent: get('MIGHTY_USER_AGENT', 'mighty-dm-sender/0.1'),
    tokenFile: resolve(get('MIGHTY_TOKEN_FILE', '.tokens.json')),
    oauthBase: `https://${network}.mn.co/oauth`,
    graphqlUrl: `https://api.mn.co/networks/${network}/graphql`,
  };
}
