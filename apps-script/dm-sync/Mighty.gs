/**
 * Mighty.gs -- Mighty GraphQL calls the DM sync uses
 * --------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only.
 *
 * What it does:
 *   Wraps the five operations proven on Sep 1 2026 and checked against the
 *   live schema on Sep 28 2026:
 *     me                          -> who the token is (the inbox owner / sender)
 *     me.directMessages           -> the inbox, newest conversation first
 *     DirectMessage.messages      -> messages in one DM, newest first
 *     network.member(id)          -> member by numeric id (mn_member_id) or GlobalID
 *     createConversation          -> send a DM; reuses the existing 1:1 thread
 *
 * Why these and not others:
 *   - createMessage is for SPACE chats; on a DM it returns "Conversation not
 *     found" (Sep 1 test). createConversation posts into an existing thread
 *     with the same people, so no conversation id has to be stored for replies.
 *   - reportSkipsAsOutcomes: true makes "member turned chat off", "Limited
 *     Member" and "sender isn't a Host" come back as a coded outcome instead of
 *     a silent no-op. Only outcome SENT means a message went out.
 *   - The payload field is `message`, not `directMessage` (the Sep 1 error).
 *
 * Known Mighty issue: Space.messages returned INTERNAL_SERVER_ERROR on Sep 1.
 * DM messages are a different field; dmPeekInbox() proves they work before
 * the sync depends on them.
 */

function dmGql_(query, variables) {
  function call(token) {
    return UrlFetchApp.fetch(DM_GRAPHQL_URL, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token, "User-Agent": DM_USER_AGENT, Accept: "application/json" },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    });
  }
  let res = call(dmAccessToken_(false));
  let body = res.getContentText();
  let json = dmParseJson_(res, body);
  const unauth = res.getResponseCode() === 401
    || (json && json.errors && json.errors.some(function (e) { return e.extensions && e.extensions.code === "UNAUTHENTICATED"; }));
  if (unauth) { res = call(dmAccessToken_(true)); body = res.getContentText(); json = dmParseJson_(res, body); }

  if (!json) throw new Error("Mighty returned non-JSON, HTTP " + res.getResponseCode() + ": " + body.slice(0, 300));
  // GraphQL errors arrive with HTTP 200 -- always check the array.
  if (json.errors && json.errors.length) {
    const err = new Error("Mighty GraphQL: " + json.errors.map(function (e) { return e.message; }).join("; "));
    err.code = json.errors[0].extensions && json.errors[0].extensions.code;
    throw err;
  }
  return json.data;
}

function dmParseJson_(res, body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

const DM_Q_ME = "query Me { me { id resourceId name } }";

const DM_Q_INBOX = [
  "query Inbox($first: Int, $after: String) {",
  "  me {",
  "    directMessages(first: $first, after: $after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes {",
  "        id",
  "        title",
  "        lastChatAt",
  "        ... on DirectMessage { isGroup participants { id resourceId name email } }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const DM_Q_MESSAGES = [
  "query Messages($id: ID!, $first: Int, $after: String) {",
  "  node(id: $id) {",
  "    ... on DirectMessage {",
  "      messages(first: $first, after: $after) {",
  "        pageInfo { hasNextPage endCursor }",
  "        nodes { id createdAt actorType textText textHtml member { id resourceId name } }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const DM_Q_MEMBER = [
  "query Member($id: ID!) {",
  "  network { member(id: $id) { id resourceId name email privateChatEnabled isLimitedMember } }",
  "}"
].join("\n");

const DM_M_SEND = [
  "mutation Send($input: CreateConversationInput!) {",
  "  createConversation(input: $input) {",
  "    outcome",
  "    errors",
  "    conversation { id }",
  "    message { id createdAt }",
  "  }",
  "}"
].join("\n");

// The token's own member. Cached for the run; the inbox owner never changes mid-run.
let DM_ME_CACHE_ = null;
function dmMe_() {
  if (!DM_ME_CACHE_) DM_ME_CACHE_ = dmGql_(DM_Q_ME).me;
  return DM_ME_CACHE_;
}

function dmInboxPage_(after) {
  return dmGql_(DM_Q_INBOX, { first: DM_INBOX_PAGE, after: after || null }).me.directMessages;
}

function dmMessagesPage_(conversationId, after) {
  const node = dmGql_(DM_Q_MESSAGES, { id: conversationId, first: DM_MESSAGES_PAGE, after: after || null }).node;
  if (!node || !node.messages) throw new Error("Conversation " + conversationId + " did not resolve as a DirectMessage.");
  return node.messages;
}

/** Member by numeric resource id (what mn_member_id holds) or GlobalID. Null if unknown. */
function dmMember_(id) {
  try {
    return dmGql_(DM_Q_MEMBER, { id: String(id) }).network.member;
  } catch (e) {
    if (e.code === "NOT_FOUND") return null;
    throw e;
  }
}

/**
 * Send a DM to one member (GlobalID). Returns
 *   { status: "sent", conversationId, messageId, sentAt }  or
 *   { status: "skipped", outcome, reason }
 * Throws on real errors (payload errors, auth, schema).
 */
function dmSend_(memberGid, html) {
  const data = dmGql_(DM_M_SEND, { input: {
    recipientIds: [memberGid],
    text: html,
    reportSkipsAsOutcomes: true,
    preserveParagraphSpacing: true
  } });
  const p = data.createConversation;
  if (p.errors && p.errors.length) throw new Error("createConversation: " + p.errors.join("; "));
  const outcome = p.outcome || (p.message ? "SENT" : null);
  if (outcome === "SENT") {
    return { status: "sent", outcome: outcome, conversationId: p.conversation && p.conversation.id,
             messageId: p.message && p.message.id, sentAt: p.message && p.message.createdAt };
  }
  return { status: "skipped", outcome: outcome, reason: DM_SKIP_REASONS[outcome] || ("Not sent (outcome " + outcome + ")") };
}

const DM_SKIP_REASONS = {
  SKIPPED_CONVERSATION_UNAVAILABLE: "Conversation or member is no longer available",
  SKIPPED_NETWORK_CHAT_DISABLED:    "Private chat is turned off for the whole network",
  SKIPPED_RECIPIENT_CHAT_DISABLED:  "Member has turned off private chat",
  SKIPPED_RECIPIENT_LIMITED_MEMBER: "Member is a Limited Member (no private chat)",
  SKIPPED_SELF_MESSAGE:             "Member is the sending account",
  SKIPPED_SENDER_CHAT_DISABLED:     "Private chat is off for the sending account",
  SKIPPED_SENDER_NOT_HOST:          "Sending account is not a Host"
};

/** gid://mighty/User/12345678 <- base64url GlobalID. Returns { type, id } or null. */
function dmDecodeGid_(gid) {
  try {
    const raw = String(gid).replace(/=+$/, "");
    const padded = raw + "===".slice(0, (4 - raw.length % 4) % 4);   // Mighty drops base64 padding
    const s = Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
    const m = s.match(/^gid:\/\/mighty\/([^/]+)\/(\d+)$/);
    return m ? { type: m[1], id: m[2] } : null;
  } catch (e) { return null; }
}

/**
 * Plain text typed in HubSpot -> the HTML Mighty's own web client sends.
 * Blank line = new paragraph; single newline = line break. Everything escaped,
 * so a "<" in a reply can't become markup.
 */
function dmTextToHtml_(text) {
  const esc = function (s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  return String(text).replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).map(function (para) {
    return '<p dir="auto">' + esc(para).replace(/\n/g, "<br>") + "</p>";
  }).join("");
}
