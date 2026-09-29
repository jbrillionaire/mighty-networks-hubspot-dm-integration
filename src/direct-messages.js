/**
 * direct-messages.js -- send and list Mighty Networks direct messages
 * -------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Server side or local only, behind the client from graphql-client.js.
 *
 * What it does:
 *   - resolveRecipient(): turns an email, a numeric member ID (the kind the
 *     Admin REST API and webhooks give you) or a GraphQL GlobalID into the
 *     GlobalID the chat mutations require.
 *   - sendDirectMessage(): starts a 1:1 DM, or posts into the existing one if
 *     the two members already have a conversation (createConversation).
 *   - replyInConversation(): posts into a known conversation (createDirectMessage).
 *   - listDirectMessages(): the sender's own DM inbox, newest first.
 *
 * Why it exists:
 *   createConversation can "succeed" without sending anything: the recipient
 *   turned off private chat, is a Limited Member, is the sender, or the
 *   sender is not a Host. We pass reportSkipsAsOutcomes: true so those come
 *   back as a coded outcome instead of an exception, and return
 *   status "skipped" with the reason. A caller that only checks for thrown
 *   errors would otherwise count skipped members as messaged.
 *
 * Constraints:
 *   - Every message is sent AS the account that authorized the token.
 *     There is no "send as the brand" or admin impersonation.
 *   - A token reaches only its own user's conversations.
 *   - Recipient lookup needs host:read:network_members (or host:read:network);
 *     memberByEmail also needs a plan with member-email visibility, and
 *     returns null (not an error) when it refuses.
 */

import { MightyApiError } from './graphql-client.js';

const MEMBER_FIELDS = 'id resourceId name';

export const QUERIES = {
  me: `query Me { me { ${MEMBER_FIELDS} email } }`,
  memberByEmail: `query MemberByEmail($email: String!) { network { memberByEmail(email: $email) { ${MEMBER_FIELDS} } } }`,
  memberById: `query MemberById($id: ID!) { network { member(id: $id) { ${MEMBER_FIELDS} } } }`,
  createConversation: `mutation SendDM($input: CreateConversationInput!) {
  createConversation(input: $input) {
    outcome
    errors
    conversation { id }
    message { id createdAt }
  }
}`,
  createDirectMessage: `mutation ReplyDM($input: CreateDirectMessageInput!) {
  createDirectMessage(input: $input) {
    errors
    message { id createdAt }
  }
}`,
  listDirectMessages: `query ListDMs($first: Int, $after: String) {
  me {
    directMessages(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        unreadCount
        ... on DirectMessage { isGroup lastChatAt participants { id name } }
      }
    }
  }
}`,
};

/** Why each skip happens, in words you can show an operator. */
export const SKIP_REASONS = {
  SKIPPED_CONVERSATION_UNAVAILABLE: 'Conversation or recipient is no longer available',
  SKIPPED_NETWORK_CHAT_DISABLED: 'Private chat is turned off for the whole Network',
  SKIPPED_RECIPIENT_CHAT_DISABLED: 'Recipient has turned off private chat',
  SKIPPED_RECIPIENT_LIMITED_MEMBER: 'Recipient is a Limited Member (private chat does not apply)',
  SKIPPED_SELF_MESSAGE: 'Recipient is the sending account',
  SKIPPED_SENDER_CHAT_DISABLED: 'Private chat is turned off for the sending account',
  SKIPPED_SENDER_NOT_HOST: 'Sending account is not a Network Host',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function whoAmI(request) {
  const data = await request(QUERIES.me);
  return data.me;
}

/**
 * Resolve an email, numeric member ID or GlobalID to a member.
 * Returns null when no member matches (or Mighty declines to say).
 */
export async function resolveRecipient(request, recipient) {
  const value = String(recipient ?? '').trim();
  if (!value) throw new Error('Recipient is empty');
  if (EMAIL_RE.test(value)) {
    const data = await request(QUERIES.memberByEmail, { email: value });
    return data.network?.memberByEmail ?? null;
  }
  try {
    const data = await request(QUERIES.memberById, { id: value });
    return data.network?.member ?? null;
  } catch (err) {
    if (err instanceof MightyApiError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

function assertNoPayloadErrors(payload, label) {
  if (payload?.errors?.length) {
    throw new MightyApiError(`${label} failed: ${payload.errors.join('; ')}`, { code: 'PAYLOAD_ERROR' });
  }
}

/**
 * Send a DM to one or more members (more than one creates a group chat).
 * @param {Function} request   client from createClient()
 * @param {string[]} recipientIds  GlobalIDs (use resolveRecipient first)
 * @param {string}   text      plain text or simple HTML (sanitized by Mighty)
 * @returns {{status:'sent'|'skipped', outcome, reason?, conversationId?, messageId?, sentAt?}}
 */
export async function sendDirectMessage(request, recipientIds, text, { title, preserveNewlines = true } = {}) {
  if (!Array.isArray(recipientIds) || recipientIds.length === 0) throw new Error('recipientIds must be a non-empty array');
  if (!text || !String(text).trim()) throw new Error('Message text is empty');

  const input = {
    recipientIds,
    text: String(text),
    reportSkipsAsOutcomes: true,
    preserveParagraphSpacing: preserveNewlines,
  };
  if (title && recipientIds.length > 1) input.title = title;

  const data = await request(QUERIES.createConversation, { input });
  const payload = data.createConversation;
  assertNoPayloadErrors(payload, 'createConversation');

  const outcome = payload.outcome ?? (payload.message ? 'SENT' : null);
  if (outcome === 'SENT') {
    return {
      status: 'sent',
      outcome,
      conversationId: payload.conversation?.id,
      messageId: payload.message?.id,
      sentAt: payload.message?.createdAt,
    };
  }
  return { status: 'skipped', outcome, reason: SKIP_REASONS[outcome] ?? `Not sent (outcome: ${outcome ?? 'none returned'})` };
}

/** Post into a conversation you already have the GlobalID for. */
export async function replyInConversation(request, conversationId, text, { replyToId } = {}) {
  if (!conversationId) throw new Error('conversationId is required');
  const input = { conversationId, text: String(text) };
  if (replyToId) input.replyToId = replyToId;
  const data = await request(QUERIES.createDirectMessage, { input });
  const payload = data.createDirectMessage;
  assertNoPayloadErrors(payload, 'createDirectMessage');
  return { status: 'sent', messageId: payload.message?.id, sentAt: payload.message?.createdAt };
}

/** One page of the sending account's DMs. Page with pageInfo.endCursor. */
export async function listDirectMessages(request, { first = 25, after } = {}) {
  const data = await request(QUERIES.listDirectMessages, { first, after });
  return data.me.directMessages;
}
