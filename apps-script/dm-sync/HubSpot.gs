/**
 * HubSpot.gs -- HubSpot calls the DM sync uses
 * --------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only.
 *
 * What it does:
 *   Finds a contact by mn_member_id, logs a DM as a Note on the contact's
 *   timeline, updates contact properties, and lists contacts with a pending
 *   reply in mn_dm_reply.
 *
 * Why it exists:
 *   HubSpot has no cron and no Mighty connector, so Apps Script is the
 *   scheduler and HubSpot is the place reps read and answer DMs.
 *
 * Credential: Script Property DM_HS_TOKEN = a NEW service key "Mighty DM Sync"
 *   with crm.objects.contacts.read + crm.objects.contacts.write only.
 *   Don't reuse a key from another integration: sharing a key means rotating
 *   it for one silently 401s the other.
 *
 * mn_member_id is not unique in HubSpot (it can't be made unique after
 * creation), so lookups search and take the first match, logging duplicates.
 */

function dmHsToken_() {
  const t = PropertiesService.getScriptProperties().getProperty("DM_HS_TOKEN");
  if (!t) throw new Error("No DM_HS_TOKEN in Script Properties (README step 2).");
  return t;
}

function dmHs_(method, path, payload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const opts = { method: method, headers: { Authorization: "Bearer " + dmHsToken_() }, muteHttpExceptions: true };
    if (payload !== undefined) { opts.contentType = "application/json"; opts.payload = JSON.stringify(payload); }
    const res = UrlFetchApp.fetch(HS_API + path, opts);
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * (attempt + 1)); continue; }
    const text = res.getContentText();
    if (code === 401 || code === 403) throw new Error("HubSpot " + code + " on " + path + ": DM_HS_TOKEN is wrong or missing a scope. " + text.slice(0, 300));
    if (code >= 300) throw new Error("HubSpot " + code + " on " + method + " " + path + ": " + text.slice(0, 400));
    return text ? JSON.parse(text) : {};
  }
  throw new Error("HubSpot " + path + ": rate limited or 5xx after 4 attempts.");
}

// One search per member per run.
const DM_HS_CONTACT_CACHE_ = {};

/** HubSpot contact id for a Mighty member id, or null. */
function dmFindContact_(memberId) {
  const key = String(memberId);
  if (key in DM_HS_CONTACT_CACHE_) return DM_HS_CONTACT_CACHE_[key];
  const r = dmHs_("post", "/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: HS_MEMBER_ID_PROP, operator: "EQ", value: key }] }],
    properties: [HS_MEMBER_ID_PROP, "firstname", "lastname"],
    limit: 2
  });
  const results = r.results || [];
  if (results.length > 1) Logger.log("WARNING: " + results.length + "+ contacts share " + HS_MEMBER_ID_PROP + " " + key + "; using " + results[0].id + ".");
  DM_HS_CONTACT_CACHE_[key] = results.length ? results[0].id : null;
  return DM_HS_CONTACT_CACHE_[key];
}

/** Note on the contact timeline. associationTypeId 202 = note -> contact. */
function dmCreateNote_(contactId, html, whenIso) {
  const r = dmHs_("post", "/crm/v3/objects/notes", {
    properties: { hs_timestamp: whenIso || new Date().toISOString(), hs_note_body: html },
    associations: [{ to: { id: String(contactId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }]
  });
  return r.id;
}

function dmUpdateContact_(contactId, properties) {
  return dmHs_("patch", "/crm/v3/objects/contacts/" + contactId, { properties: properties });
}

/** Contacts with text waiting in mn_dm_reply, oldest edit first. */
function dmPendingReplies_(limit) {
  const r = dmHs_("post", "/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: HS_REPLY_PROP, operator: "HAS_PROPERTY" }] }],
    properties: [HS_REPLY_PROP, HS_MEMBER_ID_PROP, "firstname", "lastname"],
    sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
    limit: Math.min(limit || DM_OUTBOX_BATCH, 100)
  });
  return (r.results || []).map(function (c) {
    return { contactId: c.id, text: c.properties[HS_REPLY_PROP] || "", memberId: c.properties[HS_MEMBER_ID_PROP] || "",
             name: [c.properties.firstname, c.properties.lastname].filter(String).join(" ") };
  });
}

/**
 * When the CURRENT value of mn_dm_reply was set. Each edit gets its own
 * timestamp, so it identifies "this reply" even when the same words are sent
 * twice, and a failed clear can't cause a resend of the same edit.
 */
function dmReplyVersion_(contactId) {
  const r = dmHs_("get", "/crm/v3/objects/contacts/" + contactId + "?propertiesWithHistory=" + HS_REPLY_PROP);
  const hist = (r.propertiesWithHistory && r.propertiesWithHistory[HS_REPLY_PROP]) || [];
  return hist.length ? { value: hist[0].value || "", timestamp: hist[0].timestamp } : null;  // newest first
}
