/**
 * Setup.gs -- one-time setup, safety checks and triggers for the DM sync
 * ----------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only. Run these by hand from
 *          the editor, in the order in README.md.
 *
 * What it does:
 *   dmWhoAmI            which Mighty account the token is (the inbox + sender)
 *   dmPeekInbox         reads 3 DMs and their latest messages; writes nothing
 *   dmVerifyIdMapping   proves a DM participant's id is the mn_member_id in HubSpot
 *   dmConfirmIdMapping  unlocks writing to HubSpot, after you've checked the above
 *   dmBaselineInbox     records where every existing DM stands (resumable)
 *   dmInstallTriggers   inbox every 15 min, outbox every 5 min
 *   dmRemoveTriggers    stops both; state is kept
 *   dmStatus            what's configured, what's blocked
 *
 * Why the checks exist:
 *   Nothing guarantees that a DM participant's id equals the mn_member_id your
 *   HubSpot contacts carry. If it doesn't, notes land on the wrong contacts and replies
 *   go to the wrong members. Both sync functions refuse to run until a person
 *   has looked at real matches and run dmConfirmIdMapping().
 */

function dmWhoAmI() {
  const me = dmMe_();
  Logger.log("Token acts as: " + me.name + " (member id " + me.resourceId + ", GlobalID " + me.id + ")."
    + "\nEvery synced DM is this account's inbox, and every reply is sent as this account.");
}

// Proves DM reads work (Space.messages 500'd on Sep 1; DM messages are a different field).
function dmPeekInbox() {
  const me = dmMe_();
  const page = dmInboxPage_(null);
  Logger.log("Inbox of " + me.name + ": " + page.nodes.length + " conversation(s) on page 1, more pages: " + page.pageInfo.hasNextPage);
  page.nodes.slice(0, 3).forEach(function (c) {
    const msgs = dmMessagesPage_(c.id, null).nodes;
    Logger.log("- " + c.title + " | last message " + c.lastChatAt + " | group: " + !!c.isGroup + " | " + msgs.length + " message(s) readable");
    msgs.slice(0, 2).forEach(function (m) {
      Logger.log("    " + m.createdAt + "  " + (m.member ? m.member.name : m.actorType) + ": " + String(m.textText || "").slice(0, 80));
    });
  });
}

function dmVerifyIdMapping() {
  const me = dmMe_();
  const page = dmInboxPage_(null);
  let checked = 0, idOk = 0, inHubSpot = 0;
  page.nodes.forEach(function (c) {
    if (c.isGroup || checked >= 10) return;
    const other = (c.participants || []).filter(function (p) { return p.id !== me.id; })[0];
    if (!other) return;
    checked++;
    const decoded = dmDecodeGid_(other.id);
    const viaAdminId = dmMember_(other.resourceId);   // look the member up by the numeric id HubSpot stores
    const sameMember = !!(viaAdminId && viaAdminId.id === other.id);
    if (sameMember) idOk++;
    const contactId = dmFindContact_(other.resourceId);
    if (contactId) inHubSpot++;
    Logger.log(other.name
      + "\n   DM participant: " + (decoded ? decoded.type + "/" + decoded.id : other.id) + ", resourceId " + other.resourceId
      + "\n   member(id: " + other.resourceId + ") is the same person: " + (sameMember ? "YES" : "NO")
      + "\n   HubSpot contact with " + HS_MEMBER_ID_PROP + " = " + other.resourceId + ": "
      + (contactId ? "https://app.hubspot.com/contacts/" + HS_PORTAL_ID + "/record/0-1/" + contactId : "none"));
  });
  Logger.log("\nChecked " + checked + " DM(s): id round-trips for " + idOk + ", HubSpot contact found for " + inHubSpot + "."
    + "\nOpen each HubSpot link and confirm it is the same person as the Mighty name above."
    + "\nIf every one matches, run dmConfirmIdMapping(). If any is wrong, stop: don't confirm.");
}

function dmConfirmIdMapping() {
  PropertiesService.getScriptProperties().setProperty("DM_ID_MAPPING_CONFIRMED", "yes");
  Logger.log("Confirmed. HubSpot writes are unlocked. Next: dmBaselineInbox().");
}

/**
 * Records the current newest message time for every existing conversation so
 * the sync copies only DMs that arrive AFTER this point. Large inboxes take
 * several runs: it saves a cursor and says "run again" until done.
 */
function dmBaselineInbox() {
  const p = PropertiesService.getScriptProperties();
  const started = Date.now();
  const state = dmLoadState_();
  if (!p.getProperty("DM_BASELINE_AT")) p.setProperty("DM_BASELINE_AT", new Date().toISOString());
  let after = p.getProperty("DM_BASELINE_CURSOR") || null;
  let added = 0;
  while (true) {
    const page = dmInboxPage_(after);
    page.nodes.forEach(function (c) {
      if (state[c.id]) return;
      const other = (c.participants || []).filter(function (x) { return x.id !== dmMe_().id; })[0];
      state[c.id] = { lastChatAt: c.lastChatAt || "", lastMessageId: "", memberId: other ? String(other.resourceId) : "", contactId: "", title: c.title || "" };
      added++;
    });
    if (!page.pageInfo.hasNextPage) { after = null; break; }
    after = page.pageInfo.endCursor;
    if (Date.now() - started > 4 * 60 * 1000) break;
  }
  dmSaveState_(state);
  if (after) {
    p.setProperty("DM_BASELINE_CURSOR", after);
    Logger.log("Recorded " + added + " more conversation(s) (" + Object.keys(state).length + " total). NOT done: run dmBaselineInbox() again.");
  } else {
    p.deleteProperty("DM_BASELINE_CURSOR");
    p.setProperty("DM_BASELINE_DONE", "yes");
    Logger.log("Baseline done: " + Object.keys(state).length + " conversation(s). Only DMs after "
      + dmEt_(new Date(p.getProperty("DM_BASELINE_AT"))) + " ET will be copied. Next: test (README step 9), then dmInstallTriggers().");
  }
}

function dmInstallTriggers() {
  dmRemoveTriggers();
  ScriptApp.newTrigger("dmPollInbox").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("dmPollOutbox").timeBased().everyMinutes(5).create();
  Logger.log("Installed: dmPollInbox every 15 min, dmPollOutbox every 5 min.");
}

function dmRemoveTriggers() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (["dmPollInbox", "dmPollOutbox"].indexOf(t.getHandlerFunction()) !== -1) { ScriptApp.deleteTrigger(t); n++; }
  });
  if (n) Logger.log("Removed " + n + " DM trigger(s). State and logs are untouched.");
}

function dmStatus() {
  const p = PropertiesService.getScriptProperties();
  dmCheckCreds();
  Logger.log("ID mapping confirmed: " + (p.getProperty("DM_ID_MAPPING_CONFIRMED") === "yes"));
  Logger.log("Baseline done: " + (p.getProperty("DM_BASELINE_DONE") === "yes") + (p.getProperty("DM_BASELINE_CURSOR") ? " (in progress)" : ""));
  Logger.log("Triggers: " + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(", "));
}
