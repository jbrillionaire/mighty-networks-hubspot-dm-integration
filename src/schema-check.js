/**
 * schema-check.js -- list the schema members this repo depends on
 * ---------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Imported by scripts/check-schema.js and the tests.
 *
 * What it does:
 *   findMissing(sdl) returns every required type, field, input field or enum
 *   value that is absent from a Mighty SDL document.
 *
 * Why it exists:
 *   Keeping the list next to the code (not in the script) means a new query in
 *   direct-messages.js gets its fields added here in the same change.
 */

export const REQUIRED = {
  Mutation: ['createConversation', 'createDirectMessage'],
  CreateConversationInput: ['recipientIds', 'text', 'reportSkipsAsOutcomes', 'preserveParagraphSpacing', 'title'],
  CreateConversationPayload: ['outcome', 'errors', 'conversation', 'message'],
  CreateDirectMessageInput: ['conversationId', 'text', 'replyToId'],
  Network: ['member', 'memberByEmail'],
  Member: ['directMessages', 'resourceId', 'name'],
  DirectMessageOutcome: ['SENT', 'SKIPPED_RECIPIENT_CHAT_DISABLED', 'SKIPPED_SENDER_NOT_HOST'],
};

export function findMissing(sdl, required = REQUIRED) {
  const missing = [];
  for (const [typeName, members] of Object.entries(required)) {
    const m = sdl.match(new RegExp(`\\n(?:type|input|interface|enum) ${typeName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`));
    if (!m) { missing.push(typeName); continue; }
    for (const name of members) {
      if (!new RegExp(`\\n  ${name}\\b`).test(m[1])) missing.push(`${typeName}.${name}`);
    }
  }
  return missing;
}
