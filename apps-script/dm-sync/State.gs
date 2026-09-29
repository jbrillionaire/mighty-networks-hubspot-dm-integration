/**
 * State.gs -- sheet-backed state, ledger and logs for the DM sync
 * ---------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only. Writes ONLY to the sheet
 *          in DM_SPREADSHEET_ID.
 *
 * What it does:
 *   _dm_state   one row per conversation: the newest message already copied to
 *               HubSpot, so each run only handles what's new.
 *   _dm_outbox  one row per reply: "sending" before the API call, "sent" /
 *               "skipped" / "failed" after. A reply whose key is already
 *               "sent" is never sent again.
 *   DM Log      every message handled, both directions, for people to read.
 *   DM Unmatched  DMs from members with no HubSpot contact, text kept so
 *               nothing is lost.
 *
 * Why a sheet and not PropertiesService:
 *   The properties store is capped at 500KB for the whole project; state that
 *   grows per conversation belongs in rows. Every value is written as plain
 *   text so Sheets can't turn ISO timestamps or long ids into Dates/numbers.
 */

function dmSs_() {
  if (!DM_SPREADSHEET_ID || DM_SPREADSHEET_ID.indexOf("PASTE") === 0) throw new Error("Set DM_SPREADSHEET_ID in Config.gs (README step 1).");
  return SpreadsheetApp.openById(DM_SPREADSHEET_ID);
}

function dmTab_(name, headers, hide) {
  const ss = dmSs_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat("@");
    if (hide) sh.hideSheet();
  }
  return sh;
}

// ---------- conversation state ----------
const DM_STATE_HEADERS = ["conversation_id", "last_chat_at", "last_message_id", "member_id", "contact_id", "title"];

function dmLoadState_() {
  const sh = dmTab_(DM_STATE_TAB, DM_STATE_HEADERS, true);
  const map = {};
  if (sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, DM_STATE_HEADERS.length).getValues().forEach(function (r) {
    if (r[0]) map[String(r[0])] = { lastChatAt: String(r[1]), lastMessageId: String(r[2]), memberId: String(r[3]), contactId: String(r[4]), title: String(r[5]) };
  });
  return map;
}

function dmSaveState_(map) {
  const sh = dmTab_(DM_STATE_TAB, DM_STATE_HEADERS, true);
  const rows = Object.keys(map).map(function (id) {
    const s = map[id];
    return [id, s.lastChatAt || "", s.lastMessageId || "", s.memberId || "", s.contactId || "", s.title || ""];
  });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, DM_STATE_HEADERS.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, DM_STATE_HEADERS.length).setNumberFormat("@").setValues(rows);
  }
}

// ---------- outbox ledger ----------
const DM_OUTBOX_HEADERS = ["key", "status", "contact_id", "member_id", "at", "outcome", "message_id", "detail"];

/** Row number (2+) for a key, or 0. */
function dmOutboxFind_(key) {
  const sh = dmTab_(DM_OUTBOX_TAB, DM_OUTBOX_HEADERS, true);
  if (sh.getLastRow() < 2) return { sh: sh, row: 0, status: "" };
  const keys = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (let i = keys.length - 1; i >= 0; i--) {
    if (String(keys[i][0]) === key) return { sh: sh, row: i + 2, status: String(keys[i][1]) };
  }
  return { sh: sh, row: 0, status: "" };
}

function dmOutboxWrite_(key, fields) {
  const found = dmOutboxFind_(key);
  const row = [key, fields.status || "", fields.contactId || "", fields.memberId || "",
               new Date().toISOString(), fields.outcome || "", fields.messageId || "", (fields.detail || "").slice(0, 500)];
  if (found.row) found.sh.getRange(found.row, 1, 1, row.length).setNumberFormat("@").setValues([row]);
  else found.sh.appendRow(row);
}

// ---------- human-readable logs ----------
const DM_LOG_HEADERS = ["at (ET)", "direction", "member", "member_id", "contact_id", "text", "hubspot_note_id", "status", "detail"];
const DM_UNMATCHED_HEADERS = ["at (ET)", "member", "member_id", "email", "sent_at (ET)", "text", "conversation_id"];

function dmLog_(entry) {
  dmTab_(DM_LOG_TAB, DM_LOG_HEADERS, false).appendRow([
    dmEt_(new Date()), entry.direction || "", entry.member || "", entry.memberId || "", entry.contactId || "",
    (entry.text || "").slice(0, 1000), entry.noteId || "", entry.status || "", (entry.detail || "").slice(0, 500)
  ]);
}

function dmLogUnmatched_(entry) {
  dmTab_(DM_UNMATCHED_TAB, DM_UNMATCHED_HEADERS, false).appendRow([
    dmEt_(new Date()), entry.member || "", entry.memberId || "", entry.email || "",
    entry.sentAt ? dmEt_(new Date(entry.sentAt)) : "", (entry.text || "").slice(0, 2000), entry.conversationId || ""
  ]);
}

function dmEt_(d) { return Utilities.formatDate(d, DM_TZ, "yyyy-MM-dd HH:mm"); }
