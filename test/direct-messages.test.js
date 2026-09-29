/**
 * direct-messages.test.js -- unit tests, no network
 * -------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Run:  npm test
 *
 * Why: the failures that matter here are silent (a skipped DM counted as
 * sent, a double send on re-run, a half-filled template going to a member).
 * Each test pins one of them. Fetch is faked; nothing reaches Mighty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MightyApiError } from '../src/graphql-client.js';
import { resolveRecipient, sendDirectMessage, SKIP_REASONS } from '../src/direct-messages.js';
import { runBatch, renderTemplate } from '../src/batch.js';
import { parseCsv, csvLine } from '../src/csv.js';
import { buildAuthorizeUrl, createPkcePair, refreshTokens } from '../src/oauth.js';
import { parseDotEnv } from '../src/config.js';
import { REQUIRED, findMissing } from '../src/schema-check.js';
import { createHash } from 'node:crypto';

const config = {
  network: 'my-community', clientId: 'cid', clientSecret: '', redirectUri: 'http://localhost:3000/oauth/callback',
  scopes: 'write:chats host:read:network_members', userAgent: 'test/1.0',
  oauthBase: 'https://my-community.mn.co/oauth', graphqlUrl: 'https://api.mn.co/networks/my-community/graphql',
};
const FUTURE = Date.now() + 3_600_000;
const memStore = (t) => { let tokens = t; return { load: () => tokens, save: (n) => { tokens = n; }, get: () => tokens }; };
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

test('client sends Bearer token and User-Agent, and throws on GraphQL errors returned with HTTP 200', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes({ errors: [{ message: 'nope', extensions: { code: 'FORBIDDEN' } }] }); };
  const request = createClient(config, { fetchImpl, tokenStore: memStore({ access_token: 'AT', refresh_token: 'RT', expires_at: FUTURE }) });
  await assert.rejects(request('query { me { id } }'), (e) => e instanceof MightyApiError && e.code === 'FORBIDDEN');
  assert.equal(calls[0].url, config.graphqlUrl);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer AT');
  assert.equal(calls[0].init.headers['User-Agent'], 'test/1.0');
});

test('client explains a 403 HTML page instead of a bare JSON parse error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '<html>challenge</html>' });
  const request = createClient(config, { fetchImpl, tokenStore: memStore({ access_token: 'AT', expires_at: FUTURE }) });
  await assert.rejects(request('query { me { id } }'), /User-Agent/);
});

test('expired token is refreshed first, and a rotated refresh token is persisted', async () => {
  const store = memStore({ access_token: 'OLD', refresh_token: 'RT1', expires_at: Date.now() - 1 });
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      assert.equal(init.body.get('grant_type'), 'refresh_token');
      assert.equal(init.body.get('client_secret'), null, 'public client must not send a secret');
      return jsonRes({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer NEW');
    return jsonRes({ data: { me: { id: 'g1' } } });
  };
  const request = createClient(config, { fetchImpl, tokenStore: store });
  assert.deepEqual(await request('query { me { id } }'), { me: { id: 'g1' } });
  assert.equal(store.get().refresh_token, 'RT2');
});

test('UNAUTHENTICATED triggers exactly one forced refresh and retry', async () => {
  let gql = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/oauth/token')) return jsonRes({ access_token: 'NEW', expires_in: 3600 });
    gql++;
    return gql === 1 ? jsonRes({ errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }] }) : jsonRes({ data: { ok: true } });
  };
  const store = memStore({ access_token: 'AT', refresh_token: 'RT', expires_at: FUTURE });
  const request = createClient(config, { fetchImpl, tokenStore: store });
  assert.deepEqual(await request('query { ok }'), { ok: true });
  assert.equal(gql, 2);
  assert.equal(store.get().refresh_token, 'RT', 'keeps the old refresh token when not rotated');
});

test('refresh with no stored refresh token asks you to re-authorize', async () => {
  await assert.rejects(refreshTokens(config, { access_token: 'x' }), /npm run authorize/);
});

test('resolveRecipient routes emails to memberByEmail and IDs to member(id)', async () => {
  const seen = [];
  const request = async (q, v) => {
    seen.push(v);
    if (q.includes('memberByEmail')) return { network: { memberByEmail: { id: 'gE', resourceId: '1', name: 'Alex' } } };
    return { network: { member: { id: 'gI', resourceId: v.id, name: 'Sam' } } };
  };
  assert.equal((await resolveRecipient(request, ' Alex@Example.com ')).id, 'gE');
  assert.equal((await resolveRecipient(request, '1234567')).id, 'gI');
  assert.deepEqual(seen, [{ email: 'Alex@Example.com' }, { id: '1234567' }]);
});

test('resolveRecipient returns null on NOT_FOUND instead of throwing', async () => {
  const request = async () => { throw new MightyApiError('x', { code: 'NOT_FOUND' }); };
  assert.equal(await resolveRecipient(request, '42'), null);
});

test('sendDirectMessage asks for coded skip outcomes and reports SENT', async () => {
  let input;
  const request = async (_q, v) => { input = v.input; return { createConversation: { outcome: 'SENT', errors: [], conversation: { id: 'c1' }, message: { id: 'm1', createdAt: 't' } } }; };
  const r = await sendDirectMessage(request, ['g1'], 'Hi\nthere');
  assert.equal(input.reportSkipsAsOutcomes, true);
  assert.equal(input.preserveParagraphSpacing, true);
  assert.deepEqual(r, { status: 'sent', outcome: 'SENT', conversationId: 'c1', messageId: 'm1', sentAt: 't' });
});

test('a skipped DM is reported as skipped with a readable reason, never as sent', async () => {
  for (const outcome of Object.keys(SKIP_REASONS)) {
    const request = async () => ({ createConversation: { outcome, errors: [], conversation: null, message: null } });
    const r = await sendDirectMessage(request, ['g1'], 'Hi');
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, SKIP_REASONS[outcome]);
  }
});

test('payload errors throw even when GraphQL itself succeeded', async () => {
  const request = async () => ({ createConversation: { outcome: null, errors: ['Recipient not found'], conversation: null, message: null } });
  await assert.rejects(sendDirectMessage(request, ['g1'], 'Hi'), /Recipient not found/);
});

test('renderTemplate fills known values and reports missing ones', () => {
  assert.deepEqual(renderTemplate('Hi {{first_name}} ({{Plan}})', { first_name: 'Alex', plan: 'Annual' }), { text: 'Hi Alex (Annual)', missing: [] });
  assert.deepEqual(renderTemplate('Hi {{first_name}}', { first_name: '' }).missing, ['first_name']);
});

function fakeApi({ outcomeFor = () => 'SENT', throttleTimes = 0 } = {}) {
  const sent = [];
  let throttles = throttleTimes;
  const request = async (q, v) => {
    if (q.includes('memberByEmail')) return { network: { memberByEmail: v.email === 'ghost@example.com' ? null : { id: `g:${v.email}`, resourceId: v.email, name: 'Alex Rivera' } } };
    if (q.includes('member(id')) return { network: { member: { id: `g:${v.id}`, resourceId: v.id, name: 'Sam Lee' } } };
    if (q.includes('createConversation')) {
      if (throttles-- > 0) throw new MightyApiError('slow down', { code: 'THROTTLED' });
      sent.push(v.input);
      const outcome = outcomeFor(v.input.recipientIds[0]);
      return { createConversation: { outcome, errors: [], conversation: { id: 'c' }, message: outcome === 'SENT' ? { id: 'm' } : null } };
    }
    throw new Error(`unexpected query ${q}`);
  };
  return { request, sent };
}
const noSleep = async () => {};

test('batch dry run sends nothing and previews the filled message', async () => {
  const api = fakeApi(); const logs = [];
  const summary = await runBatch({ request: api.request, rows: [{ recipient: 'a@example.com' }], template: 'Hi {{first_name}}', log: (r) => logs.push(r), sleepImpl: noSleep });
  assert.equal(api.sent.length, 0);
  assert.equal(summary.dryRun, 1);
  assert.equal(logs[0].text, 'Hi Alex', 'first name falls back to the Mighty profile name');
});

test('batch skips recipients already sent, so a re-run never double-messages', async () => {
  const api = fakeApi();
  const summary = await runBatch({
    request: api.request, send: true, sleepImpl: noSleep, template: 'Hi',
    rows: [{ recipient: 'A@example.com' }, { recipient: 'b@example.com' }],
    alreadySent: new Set(['a@example.com']),
  });
  assert.deepEqual(api.sent.map((i) => i.recipientIds[0]), ['g:b@example.com']);
  assert.equal(summary.alreadySent, 1);
});

test('batch refuses to send a message with an unfilled placeholder', async () => {
  const api = fakeApi(); const logs = [];
  await runBatch({ request: api.request, send: true, sleepImpl: noSleep, template: 'Your {{plan}} renews soon', rows: [{ recipient: 'a@example.com' }], log: (r) => logs.push(r) });
  assert.equal(api.sent.length, 0);
  assert.match(logs[0].reason, /\{\{plan\}\}/);
});

test('batch logs unknown recipients and skip outcomes separately from sends', async () => {
  const api = fakeApi({ outcomeFor: (id) => (id === 'g:off@example.com' ? 'SKIPPED_RECIPIENT_CHAT_DISABLED' : 'SENT') });
  const summary = await runBatch({
    request: api.request, send: true, sleepImpl: noSleep, template: 'Hi',
    rows: [{ recipient: 'ghost@example.com' }, { recipient: 'off@example.com' }, { recipient: '777' }],
  });
  assert.deepEqual(summary, { sent: 1, skipped: 1, failed: 1, alreadySent: 0, dryRun: 0 });
});

test('batch backs off on THROTTLED and then sends', async () => {
  const api = fakeApi({ throttleTimes: 2 }); const waits = [];
  const summary = await runBatch({ request: api.request, send: true, template: 'Hi', rows: [{ recipient: 'a@example.com' }], backoffMs: 10, delayMs: 0, sleepImpl: async (ms) => waits.push(ms) });
  assert.equal(summary.sent, 1);
  assert.deepEqual(waits, [10, 20, 0]);
});

test('batch stops on an auth failure instead of failing every remaining row', async () => {
  let calls = 0;
  const request = async (q) => {
    if (q.includes('memberByEmail')) return { network: { memberByEmail: { id: 'g', resourceId: '1', name: 'A' } } };
    calls++; throw new MightyApiError('no scope', { code: 'FORBIDDEN' });
  };
  const summary = await runBatch({ request, send: true, template: 'Hi', sleepImpl: noSleep, rows: [{ recipient: 'a@example.com' }, { recipient: 'b@example.com' }] });
  assert.equal(calls, 1);
  assert.equal(summary.failed, 1);
});

test('csv handles quoted commas, quotes, newlines and a BOM', () => {
  const rows = parseCsv('﻿Recipient,Message\r\na@example.com,"Hi, ""friend""\nsee you"\r\n\r\n');
  assert.deepEqual(rows, [{ recipient: 'a@example.com', message: 'Hi, "friend"\nsee you' }]);
  assert.equal(csvLine(['a,b', 'x"y', 'plain']), '"a,b","x""y",plain\n');
});

test('authorize URL carries PKCE S256 and state; challenge matches verifier', () => {
  const { verifier, challenge } = createPkcePair();
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  const url = new URL(buildAuthorizeUrl(config, { state: 'S', challenge }));
  assert.equal(url.origin + url.pathname, 'https://my-community.mn.co/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'S');
  assert.equal(url.searchParams.get('scope'), 'write:chats host:read:network_members');
});

test('schema check flags a renamed field and passes a complete schema', () => {
  const sdl = Object.entries(REQUIRED)
    .map(([t, fields]) => `\n${t.endsWith('Input') ? 'input' : t.endsWith('Outcome') ? 'enum' : 'type'} ${t} {\n${fields.map((f) => `  ${f}${t.endsWith('Outcome') ? '' : ': String'}`).join('\n')}\n}`)
    .join('\n');
  assert.deepEqual(findMissing(sdl), []);
  assert.deepEqual(findMissing(sdl.replace('  memberByEmail: String', '  memberLookupByEmail: String')), ['Network.memberByEmail']);
});

test('.env parser handles comments and quotes', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nB="two words"\n\nC=\'x\'\nBAD'), { A: '1', B: 'two words', C: 'x' });
});
