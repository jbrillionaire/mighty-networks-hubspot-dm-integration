/**
 * sync.test.mjs -- behavior tests for the Mighty DM sync
 * ------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 * Deploy:  Local only. Run from this folder:  node --test tests/
 * What:    Each boot() is one Apps Script execution; the fake world persists.
 * Why:     See harness.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeWorld, gid } from './harness.mjs';

// Each boot() = one Apps Script execution (fresh globals), sharing the same world.
function ready(w) {
  w.props.DM_CLIENT_ID = 'x'.repeat(43); w.props.DM_CLIENT_SECRET = 'y'.repeat(43);
  w.props.DM_REFRESH_TOKEN = 'RT0'; w.props.DM_HS_TOKEN = 'pat-test';
}
function world() {
  const w = makeWorld(); ready(w);
  w.addMember(50000001, 'Taylor Test'); w.addMember(12345, 'Alex Rivera'); w.addMember(22222, 'Sam Lee');
  const cT = w.addConv(60000001, 50000001, [{ from: 50000001, text: 'old hello', at: '2026-09-01T21:00:00Z' }]);
  const cA = w.addConv(60000002, 12345, [{ from: 'me', text: 'Welcome!', at: '2025-09-26T18:39:30Z' }]);
  const kT = w.addContact(50000001); const kA = w.addContact(12345);
  return { w, cT, cA, kT, kA };
}
const tick = (w, mins) => { w.now += mins * 60000; };

test('sync refuses to write anything before the ID check and the baseline', () => {
  const { w } = world();
  assert.throws(() => boot(w).dmPollInbox(), /dmVerifyIdMapping/);
  assert.throws(() => boot(w).dmPollOutbox(), /dmVerifyIdMapping/);
  boot(w).dmConfirmIdMapping();
  assert.throws(() => boot(w).dmPollInbox(), /dmBaselineInbox/);
  assert.equal(w.notes.length, 0);
  assert.equal(w.sendCalls.length, 0);
});

test('verify prints a HubSpot link per DM and confirms ids round-trip', () => {
  const { w, kT } = world();
  boot(w).dmVerifyIdMapping();
  const out = w.logs.join('\n');
  assert.match(out, /Taylor Test[\s\S]*User\/50000001[\s\S]*same person: YES/);
  assert.ok(out.includes('https://app.hubspot.com/contacts/YOUR_PORTAL_ID/record/0-1/' + kT));
  assert.match(out, /id round-trips for 2, HubSpot contact found for 2/);
});

test('baseline copies no history; a new inbound DM becomes exactly one note', () => {
  const { w, cT, kT } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  assert.equal(w.props.DM_BASELINE_DONE, 'yes');
  boot(w).dmPollInbox();
  assert.equal(w.notes.length, 0, 'history before baseline is not copied');

  tick(w, 5); w.addMsg(cT, 50000001, 'Is the class still on?', '2026-09-28T20:05:00Z');
  boot(w).dmPollInbox();
  assert.equal(w.notes.length, 1);
  assert.equal(w.notes[0].contactId, kT);
  assert.equal(w.notes[0].type, 202);
  assert.match(w.notes[0].body, /Mighty DM from Taylor Test/);
  assert.match(w.notes[0].body, /Is the class still on\?/);
  assert.equal(w.contacts[kT].props.mn_dm_last_inbound_at, '2026-09-28T20:05:00Z');

  boot(w).dmPollInbox(); boot(w).dmPollInbox();
  assert.equal(w.notes.length, 1, 're-runs never duplicate notes');
});

test('a reply typed in HubSpot is sent once, noted, cleared, and not re-noted by the inbox', () => {
  const { w, cT, kT } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  tick(w, 1); w.setReply(kT, 'Yes! 7pm ET.\n\nSee you there <3', 1790000000000);
  boot(w).dmPollOutbox();
  assert.equal(w.sendCalls.length, 1);
  assert.deepEqual(w.sendCalls[0].recipientIds, [gid('User', 50000001)]);
  assert.equal(w.sendCalls[0].reportSkipsAsOutcomes, true);
  assert.equal(w.sendCalls[0].text, '<p dir="auto">Yes! 7pm ET.</p><p dir="auto">See you there &lt;3</p>');
  assert.equal(w.contacts[kT].props.mn_dm_reply, '');
  assert.match(w.notes.at(-1).body, /sent by Host Account via HubSpot/);
  const before = w.notes.length;
  boot(w).dmPollInbox();
  assert.equal(w.notes.length, before, 'the sent reply is not logged a second time by the inbox');
  boot(w).dmPollOutbox();
  assert.equal(w.sendCalls.length, 1, 'nothing re-sent');
});

test('if clearing the property fails after a send, the next run clears it without resending', () => {
  const { w, kT } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  w.setReply(kT, 'Thanks!', 1790000000000);
  w.failClear = 4;  // every retry of the clear fails in this run
  assert.throws(() => boot(w).dmPollOutbox(), /HubSpot 500|rate limited/);
  assert.equal(w.sendCalls.length, 1);
  boot(w).dmPollOutbox();
  assert.equal(w.sendCalls.length, 1, 'no double send');
  assert.equal(w.contacts[kT].props.mn_dm_reply, '');
});

test('the same words sent as two separate replies go out twice', () => {
  const { w, kT } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  w.setReply(kT, 'Thanks!', 1790000000000); boot(w).dmPollOutbox();
  tick(w, 10); w.setReply(kT, 'Thanks!', 1790000600000); boot(w).dmPollOutbox();
  assert.equal(w.sendCalls.length, 2);
});

test('a member with chat off is not messaged; the rep gets a note saying why', () => {
  const { w, kT } = world();
  w.members[50000001].privateChatEnabled = false;
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  w.setReply(kT, 'Hello', 1790000000000); boot(w).dmPollOutbox();
  assert.equal(w.sendCalls.length, 0);
  assert.match(w.notes.at(-1).body, /NOT sent \(skipped\): Member has turned off private chat/);
  assert.equal(w.contacts[kT].props.mn_dm_reply, '');
});

test('a coded skip from Mighty is reported, not counted as sent', () => {
  const { w, kA } = world();
  w.sendOutcome = () => 'SKIPPED_SENDER_NOT_HOST';
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  w.setReply(kA, 'Hi', 1790000000000); boot(w).dmPollOutbox();
  assert.match(w.notes.at(-1).body, /NOT sent \(skipped\): Sending account is not a Host/);
});

test('a contact without mn_member_id gets a failure note instead of a silent drop', () => {
  const { w } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  const k = w.addContact(''); w.contacts[k].props.mn_member_id = '';
  w.setReply(k, 'Hi', 1790000000000); boot(w).dmPollOutbox();
  assert.equal(w.sendCalls.length, 0);
  assert.match(w.notes.at(-1).body, /no mn_member_id/);
});

test('DM from a member with no HubSpot contact lands in DM Unmatched with the text', () => {
  const { w } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  tick(w, 5); const c = w.addConv(55555, 22222, [{ from: 22222, text: 'hey there', at: '2026-09-28T20:05:00Z' }]);
  boot(w).dmPollInbox();
  const rows = w.sheets['DM Unmatched']._rows();
  assert.equal(rows.length, 2);
  assert.ok(rows[1].includes('hey there'));
  assert.equal(w.notes.length, 0);
});

test('a crash mid-run is caught up on the next run, including conversations below the cut', () => {
  const { w, cT, cA, kT, kA } = world();
  boot(w).dmConfirmIdMapping(); boot(w).dmBaselineInbox();
  tick(w, 5);
  w.addMsg(cA, 12345, 'from Alex', '2026-09-28T20:04:00Z');
  w.addMsg(cT, 50000001, 'from Taylor', '2026-09-28T20:05:00Z');   // newest: processed first
  w.failMessagesFor = cA.id;                                       // crash on the second conversation
  assert.throws(() => boot(w).dmPollInbox(), /simulated crash/);
  assert.equal(w.notes.length, 1);
  w.failMessagesFor = null;
  boot(w).dmPollInbox();
  assert.deepEqual(w.notes.map((n) => n.contactId).sort(), [kT, kA].sort(), 'Alex is not skipped');
  assert.equal(w.props.DM_INBOX_INCOMPLETE, undefined);
});

test('refresh token rotation is saved, and HTTP Basic is used when body auth is refused', () => {
  const w = makeWorld({ requireBasic: true }); ready(w);
  boot(w).dmWhoAmI();
  assert.equal(w.props.DM_REFRESH_TOKEN, 'RT1', 'rotated refresh token persisted');
  assert.match(w.logs.join('\n'), /Token acts as: Host Account/);
});

test('sign-in rejects a mismatched state', () => {
  const w = makeWorld(); ready(w);
  boot(w).dmLogAuthorizeUrl();
  assert.match(w.logs.at(-1), /state=aaaaaaaabbbbccccddddeeeeeeeeeeee/);
  assert.throws(() => boot(w).dmExchangeCode('code', 'wrong'), /state does not match/);
});

test('helpers: GlobalID decode and HTML escaping', () => {
  const api = boot(makeWorld());
  assert.deepEqual({ ...api.dmDecodeGid_(gid('Pair', 60000001)) }, { type: 'Pair', id: '60000001' });
  assert.equal(api.dmTextToHtml_('a\nb & <c>'), '<p dir="auto">a<br>b &amp; &lt;c&gt;</p>');
});
