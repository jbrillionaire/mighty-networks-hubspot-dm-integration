/**
 * harness.mjs -- runs the mighty-dm-sync .gs files in Node, unchanged
 * -------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 * Deploy:  Local only. Never paste into Apps Script.
 * What:    Fake Apps Script services (UrlFetchApp, Sheets, Properties, Cache,
 *          Lock, Utilities), a fake Mighty GraphQL API and a fake HubSpot API.
 * Why:     Apps Script has no test runner. The failures that matter here are
 *          silent (double sends, duplicate notes, skipped conversations), so
 *          they're pinned by tests before anything touches real members.
 */
// a fake Mighty GraphQL API and a fake HubSpot API.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const FILES = ['Config.gs', 'Auth.gs', 'Mighty.gs', 'HubSpot.gs', 'State.gs', 'Inbox.gs', 'Outbox.gs', 'Setup.gs'];
const gid = (type, id) => Buffer.from(`gid://mighty/${type}/${id}`).toString('base64url');

function makeWorld(opts = {}) {
  const w = {
    props: {}, cache: {}, logs: [], sheets: {}, now: Date.parse('2026-09-28T20:00:00Z'),
    // Mighty
    me: { id: gid('User', 50000000), resourceId: '50000000', name: 'Host Account' },
    members: {}, convs: [], sendCalls: [], sendOutcome: () => 'SENT', requireBasic: !!opts.requireBasic,
    refreshCount: 0, failMessagesFor: null,
    // HubSpot
    contacts: {}, notes: [], hsCalls: [], failClear: false, hsSeq: 1000,
  };
  w.addMember = (id, name, extra = {}) => (w.members[id] = { id: gid('User', id), resourceId: String(id), name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, privateChatEnabled: true, isLimitedMember: false, ...extra });
  w.addConv = (convId, memberId, msgs = [], extra = {}) => {
    const c = { id: gid('Pair', convId), title: w.members[memberId].name, memberId, msgs: [], isGroup: false, ...extra };
    w.convs.push(c); msgs.forEach((m) => w.addMsg(c, m.from, m.text, m.at)); return c;
  };
  w.addMsg = (c, fromId, text, at) => {
    const author = fromId === 'me' ? w.me : w.members[fromId];
    c.msgs.push({ id: gid('PrivateMessage', 900000 + Math.floor(Math.random() * 1e6)), createdAt: at, actorType: 'USER', textText: text, textHtml: `<p dir="auto">${text}</p>`, member: { id: author.id, resourceId: author.resourceId, name: author.name } });
  };
  w.lastChatAt = (c) => (c.msgs.length ? c.msgs.reduce((a, m) => (m.createdAt > a ? m.createdAt : a), '') : null);
  w.addContact = (memberId, extra = {}) => { const id = String(w.hsSeq++); w.contacts[id] = { id, props: { mn_member_id: String(memberId), firstname: 'C', lastname: String(memberId), ...extra }, history: {} }; return id; };
  w.setReply = (contactId, text, ts) => { const c = w.contacts[contactId]; c.props.mn_dm_reply = text; (c.history.mn_dm_reply ||= []).unshift({ value: text, timestamp: ts }); };
  return w;
}

function mightyGraphql(w, body) {
  const { query, variables: v } = JSON.parse(body);
  const op = query.match(/(query|mutation) (\w+)/)[2];
  const data = (d) => ({ data: d });
  if (op === 'Me') return data({ me: w.me });
  if (op === 'Inbox') {
    const sorted = [...w.convs].sort((a, b) => (w.lastChatAt(b) || '').localeCompare(w.lastChatAt(a) || ''));
    const start = v.after ? Number(v.after) : 0, page = sorted.slice(start, start + v.first);
    return data({ me: { directMessages: { pageInfo: { hasNextPage: start + v.first < sorted.length, endCursor: String(start + v.first) },
      nodes: page.map((c) => ({ id: c.id, title: c.title, lastChatAt: w.lastChatAt(c), isGroup: c.isGroup,
        participants: [{ id: w.me.id, resourceId: w.me.resourceId, name: w.me.name, email: null }, { ...w.members[c.memberId] }] })) } } });
  }
  if (op === 'Messages') {
    const c = w.convs.find((x) => x.id === v.id);
    if (w.failMessagesFor === v.id) throw new Error('simulated crash');
    const sorted = [...c.msgs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = v.after ? Number(v.after) : 0;
    return data({ node: { messages: { pageInfo: { hasNextPage: start + v.first < sorted.length, endCursor: String(start + v.first) }, nodes: sorted.slice(start, start + v.first) } } });
  }
  if (op === 'Member') {
    const m = Object.values(w.members).find((x) => x.resourceId === v.id || x.id === v.id);
    if (!m) return { data: { network: { member: null } }, errors: [{ message: 'Member not found', extensions: { code: 'NOT_FOUND' } }] };
    return data({ network: { member: m } });
  }
  if (op === 'Send') {
    const inp = v.input; w.sendCalls.push(inp);
    const m = Object.values(w.members).find((x) => x.id === inp.recipientIds[0]);
    const outcome = w.sendOutcome(m);
    if (outcome !== 'SENT') return data({ createConversation: { outcome, errors: [], conversation: null, message: null } });
    let c = w.convs.find((x) => x.memberId === Number(m.resourceId) || String(x.memberId) === m.resourceId);
    if (!c) c = w.addConv(700000 + w.convs.length, Number(m.resourceId));
    const at = new Date(w.now).toISOString().replace('.000', '');
    w.addMsg(c, 'me', inp.text, at);
    const msg = c.msgs[c.msgs.length - 1];
    return data({ createConversation: { outcome: 'SENT', errors: [], conversation: { id: c.id }, message: { id: msg.id, createdAt: at } } });
  }
  throw new Error('unknown op ' + op);
}

function hubspot(w, method, url, payload) {
  const u = new URL(url); w.hsCalls.push(method + ' ' + u.pathname);
  const body = payload ? JSON.parse(payload) : null;
  if (u.pathname === '/crm/v3/objects/contacts/search') {
    const f = body.filterGroups[0].filters[0];
    let res = Object.values(w.contacts);
    if (f.operator === 'EQ') res = res.filter((c) => c.props[f.propertyName] === f.value);
    if (f.operator === 'HAS_PROPERTY') res = res.filter((c) => c.props[f.propertyName]);
    return { results: res.slice(0, body.limit).map((c) => ({ id: c.id, properties: { ...c.props } })) };
  }
  if (u.pathname === '/crm/v3/objects/notes') {
    const id = String(5000 + w.notes.length);
    w.notes.push({ id, contactId: body.associations[0].to.id, body: body.properties.hs_note_body, ts: body.properties.hs_timestamp, type: body.associations[0].types[0].associationTypeId });
    return { id };
  }
  const m = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
  if (m && method === 'patch') {
    if (w.failClear && body.properties.mn_dm_reply === '') { w.failClear--; return { __status: 500, __text: 'boom' }; }
    Object.assign(w.contacts[m[1]].props, body.properties); return { id: m[1] };
  }
  if (m && method === 'get') {
    const c = w.contacts[m[1]];
    return { id: c.id, properties: c.props, propertiesWithHistory: { mn_dm_reply: c.history.mn_dm_reply || [] } };
  }
  throw new Error('unknown hubspot ' + method + ' ' + u.pathname);
}

function makeSheet() {
  const s = { rows: [], hidden: false };
  const ensure = (r, c) => { while (s.rows.length < r) s.rows.push([]); };
  const sheet = {
    getLastRow: () => { for (let i = s.rows.length; i > 0; i--) if (s.rows[i - 1].some((v) => v !== '' && v !== undefined)) return i; return 0; },
    getMaxRows: () => 1000,
    appendRow: (vals) => { s.rows.splice(sheet.getLastRow(), 0, vals.map(String)); },
    hideSheet: () => { s.hidden = true; }, isSheetHidden: () => s.hidden, setFrozenRows: () => {},
    getRange: (r, c, nr = 1, nc = 1) => {
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
        setValues: (vals) => { ensure(r + nr - 1); vals.forEach((row, i) => row.forEach((v, j) => { (s.rows[r - 1 + i] ||= [])[c - 1 + j] = String(v); })); return range; },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.rows[r - 1 + i]) s.rows[r - 1 + i][c - 1 + j] = ''; return range; },
        setNumberFormat: () => range, setFontWeight: () => range,
      };
      return range;
    },
    _rows: () => s.rows.slice(0, sheet.getLastRow()),
  };
  return sheet;
}

export function boot(w) {
  const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
  const ctx = {
    console,
    Logger: { log: (m) => w.logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => w.props[k] ?? null, setProperty: (k, v) => { w.props[k] = String(v); },
      deleteProperty: (k) => { delete w.props[k]; }, setProperties: (o) => Object.assign(w.props, o) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => w.cache[k] ?? null, put: (k, v) => { w.cache[k] = v; }, remove: (k) => { delete w.cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
    SpreadsheetApp: { openById: () => ({
      getSheetByName: (n) => w.sheets[n] || null,
      insertSheet: (n) => (w.sheets[n] = makeSheet()) }) },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sleep: () => {},
      base64Encode: (s) => Buffer.from(s).toString('base64'),
      base64DecodeWebSafe: (s) => [...Buffer.from(s, 'base64url')],
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      formatDate: (d, tz) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', ''),
    },
    UrlFetchApp: { fetch: (url, o = {}) => {
      if (url.endsWith('/oauth/token')) {
        const basic = o.headers && o.headers.Authorization && o.headers.Authorization.startsWith('Basic ');
        if (w.requireBasic && !basic) return resp(401, JSON.stringify({ error: 'invalid_client' }));
        w.refreshCount++;
        return resp(200, JSON.stringify({ access_token: 'AT' + w.refreshCount, refresh_token: 'RT' + w.refreshCount, expires_in: 3600, scope: 'read:network' }));
      }
      if (url.startsWith('https://api.mn.co/')) {
        assert.ok(o.headers['User-Agent'], 'User-Agent sent to Mighty');
        assert.match(o.headers.Authorization, /^Bearer AT/);
        return resp(200, JSON.stringify(mightyGraphql(w, o.payload)));
      }
      if (url.startsWith('https://api.hubapi.com')) {
        const r = hubspot(w, (o.method || 'get').toLowerCase(), url, o.payload);
        if (r.__status) return resp(r.__status, r.__text);
        return resp(200, JSON.stringify(r));
      }
      throw new Error('unexpected fetch ' + url);
    } },
  };
  ctx.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [w.now])); } static now() { return w.now; } };
  vm.createContext(ctx);
  let src = FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n;\n');
  src = src.replace('const DM_SPREADSHEET_ID = "PASTE_DM_SHEET_ID";', 'const DM_SPREADSHEET_ID = "TEST_SHEET";');
  // expose top-level const/let/function to the test
  vm.runInContext(src + '\n;globalThis.__api = { dmPollInbox, dmPollOutbox, dmBaselineInbox, dmConfirmIdMapping, dmVerifyIdMapping, dmExchangeCode, dmLogAuthorizeUrl, dmTextToHtml_, dmDecodeGid_, dmPeekInbox, dmWhoAmI };', ctx);
  return ctx.__api;
}

export { makeWorld, gid };
