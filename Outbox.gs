/**
 * Outbox.gs -- Phase 2: reply from HubSpot
 * ----------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only. Trigger: dmPollOutbox
 *          every 5 minutes (installed by dmInstallTriggers in Setup.gs).
 *
 * What it does:
 *   A rep types a reply into the contact's "Mighty DM reply" property
 *   (mn_dm_reply) in HubSpot. Within ~5 minutes this sends it to that member
 *   as a Mighty DM from the Host account, logs a Note ("Mighty DM sent by ...
 *   via HubSpot"), and clears the property so it's ready for the next reply.
 *   If the member has no thread yet, the same call starts one.
 *
 * Why it polls HubSpot instead of a webhook:
 *   An Apps Script web app answers POSTs with a 302 redirect. HubSpot's
 *   webhook action can read that as a failure and retry, which would DM the
 *   member again. Polling needs no public URL, no shared secret, and no retry
 *   semantics to defend against.
 *
 * Double-send protection (the failure members would notice):
 *   Each reply gets a ledger key = contact id + the timestamp HubSpot stamped
 *   on that edit of mn_dm_reply. (Not the text: a rep sending "Thanks!" twice
 *   is two replies.) The ledger row is written as "sending" BEFORE the API
 *   call and "sent" after. A key already finished is never sent again, only
 *   cleared. A key left at "sending" means a run died mid-call and we can't
 *   know if it went out: it is NOT retried. The rep gets a note to check.
 *
 * Nothing is ever silently dropped: every outcome writes a Note on the contact
 * and a row in "DM Log", and the property is cleared only after that.
 */

function dmPollOutbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { Logger.log("Another DM run holds the lock; skipping this one."); return; }
  try {
    if (PropertiesService.getScriptProperties().getProperty("DM_ID_MAPPING_CONFIRMED") !== "yes") {
      throw new Error("Blocked: run dmVerifyIdMapping() and dmConfirmIdMapping() first.");
    }
    dmSendPendingReplies_();
  } finally {
    lock.releaseLock();
  }
}

function dmSendPendingReplies_() {
  const started = Date.now();
  const pending = dmPendingReplies_(DM_OUTBOX_BATCH);
  if (!pending.length) return;
  const me = dmMe_();
  let sent = 0, skipped = 0, failed = 0;

  pending.forEach(function (r) {
    if (Date.now() - started > 4.5 * 60 * 1000) return;
    const text = String(r.text || "").trim();
    if (!text) { dmClearReply_(r.contactId); return; }
    const version = dmReplyVersion_(r.contactId);
    if (!version || String(version.value).trim() !== text) return;  // edited since the search ran; next run picks it up
    const key = r.contactId + ":" + version.timestamp;               // this edit, not this wording
    const prior = dmOutboxFind_(key).status;

    if (prior === "sent" || prior === "skipped" || prior === "failed" || prior === "unknown") {
      dmClearReply_(r.contactId);  // this exact edit was handled on an earlier run; only the clear failed
      return;
    }
    if (prior === "sending") {
      dmFinish_(r, key, { status: "unknown", detail: "A previous run stopped mid-send. It may or may not have been delivered, so it was NOT resent. Check the Mighty thread before retyping." }, me, text);
      failed++;
      return;
    }

    // Resolve and pre-check the member so a skip is explained before any send.
    if (!r.memberId) { dmFinish_(r, key, { status: "failed", detail: "Contact has no " + HS_MEMBER_ID_PROP + ", so there is no Mighty member to message." }, me, text); failed++; return; }
    let member;
    try { member = dmMember_(r.memberId); }
    catch (e) { Logger.log("Member lookup failed for " + r.memberId + ": " + e.message + " (left pending for the next run)"); return; }
    if (!member) { dmFinish_(r, key, { status: "failed", detail: "No Mighty member with id " + r.memberId + "." }, me, text); failed++; return; }
    if (member.email && DM_EXCLUDE_EMAIL_RE.test(member.email)) { dmFinish_(r, key, { status: "skipped", detail: "Mighty staff/test account." }, me, text); skipped++; return; }
    if (member.isLimitedMember) { dmFinish_(r, key, { status: "skipped", outcome: "SKIPPED_RECIPIENT_LIMITED_MEMBER", detail: DM_SKIP_REASONS.SKIPPED_RECIPIENT_LIMITED_MEMBER }, me, text); skipped++; return; }
    if (member.privateChatEnabled === false) { dmFinish_(r, key, { status: "skipped", outcome: "SKIPPED_RECIPIENT_CHAT_DISABLED", detail: DM_SKIP_REASONS.SKIPPED_RECIPIENT_CHAT_DISABLED }, me, text); skipped++; return; }

    dmOutboxWrite_(key, { status: "sending", contactId: r.contactId, memberId: r.memberId });
    let result;
    try {
      result = dmSend_(member.id, dmTextToHtml_(text));
    } catch (e) {
      if (e.code || /^createConversation:/.test(e.message)) {
        // Mighty answered with an error: definitely not sent.
        dmFinish_(r, key, { status: "failed", detail: "Mighty refused the send: " + e.message }, me, text);
        failed++;
      } else {
        // Network-level failure: can't tell if it went out. Leave "sending"; next run reports it.
        Logger.log("Send to " + member.name + " ended without a response: " + e.message);
      }
      return;
    }

    if (result.status === "sent") {
      dmFinish_(r, key, { status: "sent", outcome: "SENT", messageId: result.messageId, sentAt: result.sentAt }, me, text, member);
      sent++;
    } else {
      dmFinish_(r, key, { status: "skipped", outcome: result.outcome, detail: result.reason }, me, text, member);
      skipped++;
    }
    Utilities.sleep(DM_SEND_PAUSE_MS);
  });

  Logger.log("Outbox: " + sent + " sent, " + skipped + " skipped, " + failed + " failed/unknown.");
}

/** Ledger -> note -> log -> clear, in that order, so the reply text survives until it's recorded. */
function dmFinish_(r, key, res, me, text, member) {
  dmOutboxWrite_(key, { status: res.status, contactId: r.contactId, memberId: r.memberId,
                        outcome: res.outcome, messageId: res.messageId, detail: res.detail });
  const when = res.sentAt || new Date().toISOString();
  const heading = res.status === "sent"
    ? "Mighty DM sent by " + dmEsc_(me.name) + " via HubSpot"
    : "Mighty DM NOT sent (" + res.status + "): " + dmEsc_(res.detail || "");
  const html = "<p><strong>" + heading + "</strong> &middot; " + dmEt_(new Date(when)) + " ET</p>" + dmTextToHtml_(text);
  const noteId = dmCreateNote_(r.contactId, html, when);
  dmLog_({ direction: "outbound (HubSpot)", member: member ? member.name : r.name, memberId: r.memberId,
           contactId: r.contactId, text: text, noteId: noteId, status: res.status, detail: res.detail });
  dmClearReply_(r.contactId);
}

function dmClearReply_(contactId) {
  const props = {}; props[HS_REPLY_PROP] = "";
  dmUpdateContact_(contactId, props);
}
