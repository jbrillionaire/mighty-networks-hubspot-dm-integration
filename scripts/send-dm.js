/**
 * send-dm.js -- send one direct message
 * -------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Run locally: npm run send -- --to <email|member id> --text "Hi!" [--send]
 *
 * What it does:
 *   Resolves the recipient, prints who will receive what from whom, and sends
 *   only when --send is passed. Without --send it is a dry run.
 *
 * Why it exists:
 *   A DM cannot be unsent by this tool, and it lands in a real person's inbox
 *   with a push notification. Dry run by default makes the first mistake cheap.
 *
 * Flags:
 *   --to        email, numeric member ID, or GraphQL GlobalID (repeat for a group DM)
 *   --text      message text; use \n for a line break
 *   --text-file read the message from a file instead of --text
 *   --send      actually send (otherwise dry run)
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createClient } from '../src/graphql-client.js';
import { resolveRecipient, sendDirectMessage, whoAmI } from '../src/direct-messages.js';

const { values } = parseArgs({
  options: {
    to: { type: 'string', multiple: true },
    text: { type: 'string' },
    'text-file': { type: 'string' },
    send: { type: 'boolean', default: false },
  },
});

if (!values.to?.length) throw new Error('Pass at least one --to <email|member id>');
const text = values['text-file'] ? readFileSync(values['text-file'], 'utf8') : (values.text ?? '').replace(/\\n/g, '\n');
if (!text.trim()) throw new Error('Pass --text "..." or --text-file path');

const request = createClient(loadConfig());
const me = await whoAmI(request);

const recipients = [];
for (const to of values.to) {
  const member = await resolveRecipient(request, to);
  if (!member) throw new Error(`No member found for "${to}" (or your token cannot look them up)`);
  recipients.push(member);
}

console.log(`From: ${me.name}`);
console.log(`To:   ${recipients.map((m) => `${m.name} (${m.resourceId})`).join(', ')}`);
console.log(`Text:\n${text}\n`);

if (!values.send) {
  console.log('Dry run. Add --send to deliver it.');
} else {
  const result = await sendDirectMessage(request, recipients.map((m) => m.id), text);
  if (result.status === 'sent') console.log(`Sent. Message ${result.messageId} in conversation ${result.conversationId}`);
  else { console.log(`Not sent: ${result.reason} (${result.outcome})`); process.exitCode = 2; }
}
