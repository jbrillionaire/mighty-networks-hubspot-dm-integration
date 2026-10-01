/**
 * Inbox.gs -- Phase 1: Mighty DMs into HubSpot
 * --------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only. Trigger: dmPollInbox
 *          every 15 minutes (installed by dmInstallTriggers in Setup.gs).
 *
 * What it does:
 *   Reads the Host inbox newest-first, and for every conversation with a
 *   message newer than last time, copies each new message onto the member's
 *   HubSpot contact as a Note ("Mighty DM from ..."), and stamps
 *   mn_dm_last_inbound_at when the member wrote. Messages the Host typed in
 *   the Mighty app are copied too, so the HubSpot timeline shows both sides.
 *
 * Why it polls:
 *   Mighty has no webhook event for DMs (WebhookEventType has no chat events),
 *   so the only way to notice a new DM is to look.
 *
 * Rules that keep it from double-logging or losing messages:
 *   - It refuses to run until dmBaselineInbox() has recorded where every
 *     existing conversation stands, so history is never dumped into HubSpot.
 *   - The inbox is ordered by most recent message, so the first conversation
 *     that hasn't changed means none of the older ones have: stop there.
 *   - State is saved after each conversation, so a timeout or crash mid-run
 *     resumes without re-creating notes, and the next run scans the whole
 *     inbox once so conversations below the cut-off aren't missed.
 *   - Replies this script sent from HubSpot already have a note; their
 *     message ids are in the outbox ledger and are skipped here.
 *   - Group DMs are skipped (logged once); only 1:1 threads map to one contact.
 *   - A member with no HubSpot contact goes to "DM Unmatched" with the text.
 */

function dmPollInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { Logger.log("Another DM run holds the lock; skipping this one."); return; }
  try {
    dmRequireReady_();
    dmSyncInbox_();
  } finally {
    lock.releaseLock();
  }
}

function dmRequireReady_() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("DM_ID_MAPPING_CONFIRMED") !== "yes") {
    throw new Error("Blocked: run dmVerifyIdMapping(), check the matches in HubSpot, then run dmConfirmIdMapping(). Nothing is written to HubSpot until then.");
  }
  if (p.getProperty("DM_BASELINE_DONE") !== "yes") {
    throw new Error("Blocked: run dmBaselineInbox() until it reports done. Otherwise every past DM would be copied into HubSpot.");
  }
}

function dmSyncInbox_() {
  const started = Date.now();
  const me = dmMe_();
  const state = dmLoadState_();
  const baselineAt = PropertiesService.getScriptProperties().getProperty("DM_BASELINE_AT");
  const alreadyNoted = dmSentMessageIds_();
  const props = PropertiesService.getScriptProperties();
  // After a run was cut short, changed conversations can sit BELOW ones already
  // handled, so the early stop would never reach them: scan everything once.
  const fullScan = props.getProperty("DM_INBOX_INCOMPLETE") === "yes";
  props.setProperty("DM_INBOX_INCOMPLETE", "yes");  // cleared only by a clean finish, so a crash also triggers catch-up
  let after = null, pages = 0, convsChanged = 0, notes = 0, unmatched = 0, stop = false, timedOut = false;

  while (!stop) {
    const page = dmInboxPage_(after);
    pages++;
    for (let i = 0; i < page.nodes.length; i++) {
      const conv = page.nodes[i];
      const known = state[conv.id];
      if (known && known.lastChatAt === (conv.lastChatAt || "")) {
        if (fullScan) continue;
        stop = true; break;  // newest-first: everything older is unchanged too
      }
      if (Date.now() - started > 4.5 * 60 * 1000) { stop = true; timedOut = true; Logger.log("Time budget reached; the next run continues."); break; }

      convsChanged++;
      const res = dmSyncConversation_(conv, known, me, baselineAt, alreadyNoted);
      notes += res.notes; unmatched += res.unmatched;
      state[conv.id] = res.state;
      dmSaveState_(state);
    }
    if (stop || !page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  if (!timedOut) props.deleteProperty("DM_INBOX_INCOMPLETE");
  Logger.log("Inbox" + (fullScan ? " (full catch-up scan)" : "") + ": " + convsChanged + " conversation(s) with new messages, " + notes + " note(s) added, "
    + unmatched + " message(s) to '" + DM_UNMATCHED_TAB + "', " + pages + " page(s) read.");
}

/** Copy one conversation's new messages. Returns { state, notes, unmatched }. */
function dmSyncConversation_(conv, known, me, baselineAt, alreadyNoted) {
  const next = {
    lastChatAt: conv.lastChatAt || "",
    lastMessageId: known ? known.lastMessageId : "",
    memberId: known ? known.memberId : "",
    contactId: known ? known.contactId : "",
    title: conv.title || ""
  };
  if (conv.isGroup) {
    if (!known) dmLog_({ direction: "skipped", member: conv.title, status: "skipped", detail: "Group DM: not synced (only 1:1 threads map to one contact)" });
    return { state: next, notes: 0, unmatched: 0 };
  }

  const other = (conv.participants || []).filter(function (p) { return p.id !== me.id; })[0];
  if (!other) return { state: next, notes: 0, unmatched: 0 };
  if (other.email && DM_EXCLUDE_EMAIL_RE.test(other.email)) {
    return { state: next, notes: 0, unmatched: 0 };  // Mighty staff/test account
  }
  next.memberId = String(other.resourceId);

  // Collect messages newer than the high-water mark, newest first, then flip to chronological.
  // Compare as times, not strings: Mighty sends "…:05Z", toISOString() writes "…:05.000Z".
  const sinceMs = Date.parse(known ? known.lastChatAt : (baselineAt || "")) || 0;
  const fresh = [];
  let after = null, done = false;
  for (let pg = 0; pg < DM_MAX_MESSAGE_PAGES && !done; pg++) {
    const conn = dmMessagesPage_(conv.id, after);
    for (let i = 0; i < conn.nodes.length; i++) {
      const m = conn.nodes[i];
      if ((known && m.id === known.lastMessageId) || (sinceMs && Date.parse(m.createdAt) <= sinceMs)) { done = true; break; }
      fresh.push(m);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  if (!done && fresh.length >= DM_MAX_MESSAGE_PAGES * DM_MESSAGES_PAGE) {
    Logger.log("WARNING: " + other.name + " has more than " + fresh.length + " new messages; older ones beyond that were not copied.");
  }
  fresh.reverse();
  if (fresh.length) next.lastMessageId = fresh[fresh.length - 1].id;

  let contactId = next.contactId || dmFindContact_(next.memberId);
  next.contactId = contactId || "";
  let notes = 0, unmatched = 0, latestInbound = "";

  fresh.forEach(function (m) {
    if (m.actorType === "SYSTEM") return;
    if (alreadyNoted[m.id]) return;  // sent from HubSpot by this script; it already has a note
    const inbound = !(m.member && m.member.id === me.id);
    const who = m.member ? m.member.name : (inbound ? other.name : me.name);
    const text = m.textText || "";

    if (!contactId) {
      dmLogUnmatched_({ member: other.name, memberId: next.memberId, email: other.email, sentAt: m.createdAt, text: (inbound ? "" : "[sent by " + who + "] ") + text, conversationId: conv.id });
      unmatched++;
      return;
    }
    const heading = inbound
      ? "Mighty DM from " + dmEsc_(who)
      : "Mighty DM sent by " + dmEsc_(who) + " (in the Mighty app)";
    const html = "<p><strong>" + heading + "</strong> &middot; " + dmEt_(new Date(m.createdAt)) + " ET</p>"
      + (m.textHtml || dmTextToHtml_(text));
    const noteId = dmCreateNote_(contactId, html, m.createdAt);
    notes++;
    if (inbound) latestInbound = m.createdAt;
    dmLog_({ direction: inbound ? "inbound" : "outbound (Mighty app)", member: other.name, memberId: next.memberId,
             contactId: contactId, text: text, noteId: noteId, status: "noted" });
  });

  if (latestInbound) {
    const props = {}; props[HS_LAST_INBOUND_PROP] = latestInbound;
    dmUpdateContact_(contactId, props);
  }
  return { state: next, notes: notes, unmatched: unmatched };
}

/** Message ids this script sent (from the outbox ledger), so inbox sync skips them. */
function dmSentMessageIds_() {
  const sh = dmTab_(DM_OUTBOX_TAB, DM_OUTBOX_HEADERS, true);
  const out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 7, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { if (r[0]) out[String(r[0])] = true; });
  return out;
}

function dmEsc_(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
