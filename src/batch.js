/**
 * batch.js -- send a personalised DM to a list of members, safely
 * ---------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Imported by scripts/send-batch.js (and by the tests).
 *
 * What it does:
 *   For each row: fill the message template, resolve the recipient, send,
 *   and append the result to a log. Rows already logged as "sent" are skipped
 *   on the next run, so a crashed or throttled run can simply be re-run.
 *   Waits between sends and backs off when Mighty answers THROTTLED.
 *
 * Why it exists:
 *   Outreach to hundreds of members fails half way in practice: a token
 *   expires, the rate limit trips, the laptop sleeps. Without a resumable log
 *   the only choices are to stop, or re-run and DM the first half twice.
 *   Double-messaging members is the one failure here people notice.
 *
 * Template: {{first_name}}, {{name}} (Mighty profile name) and any CSV column,
 * e.g. {{plan}}. An unknown placeholder stops the row instead of sending
 * "Hi {{first_name}}" to a real person.
 */

import { MightyApiError } from './graphql-client.js';
import { resolveRecipient, sendDirectMessage } from './direct-messages.js';

export function renderTemplate(template, vars) {
  const missing = [];
  const out = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const v = vars[key.toLowerCase()];
    if (v === undefined || v === null || String(v).trim() === '') { missing.push(key); return ''; }
    return String(v);
  });
  return { text: out, missing };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object}   opts
 * @param {Function} opts.request       client from createClient()
 * @param {object[]} opts.rows          parsed CSV rows; needs a `recipient` column
 * @param {string}   opts.template      default message; a row's `message` column overrides it
 * @param {Set}      opts.alreadySent   recipients to skip (from the previous log)
 * @param {boolean}  opts.send          false = dry run
 * @param {Function} opts.log           called with each result row
 */
export async function runBatch({
  request, rows, template, alreadySent = new Set(), send = false, log = () => {},
  delayMs = 3000, limit = Infinity, maxRetries = 4, backoffMs = 60_000, sleepImpl = sleep,
}) {
  const summary = { sent: 0, skipped: 0, failed: 0, alreadySent: 0, dryRun: 0 };
  let attempted = 0;

  for (const row of rows) {
    const recipient = (row.recipient || row.email || row.member_id || '').trim();
    const base = { recipient, at: new Date().toISOString() };
    if (!recipient) { log({ ...base, status: 'failed', reason: 'Row has no recipient' }); summary.failed++; continue; }
    if (alreadySent.has(recipient.toLowerCase())) { summary.alreadySent++; continue; }
    if (attempted >= limit) break;
    attempted++;

    let member;
    try {
      member = await resolveRecipient(request, recipient);
    } catch (err) {
      log({ ...base, status: 'failed', reason: `Lookup error: ${err.message}` }); summary.failed++; continue;
    }
    if (!member) { log({ ...base, status: 'failed', reason: 'No member found (or lookup not permitted)' }); summary.failed++; continue; }

    const firstName = row.first_name || (member.name || '').split(/\s+/)[0];
    const { text, missing } = renderTemplate(row.message || template, { ...row, first_name: firstName, name: member.name });
    if (missing.length) {
      log({ ...base, memberId: member.resourceId, status: 'failed', reason: `Missing value for {{${missing.join('}}, {{')}}}` });
      summary.failed++; continue;
    }

    if (!send) {
      log({ ...base, memberId: member.resourceId, name: member.name, status: 'dry-run', text });
      summary.dryRun++; continue;
    }

    let result, lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try { result = await sendDirectMessage(request, [member.id], text); break; } catch (err) {
        lastErr = err;
        if (err instanceof MightyApiError && err.code === 'THROTTLED' && attempt < maxRetries) {
          await sleepImpl(backoffMs * (attempt + 1)); continue;
        }
        break;
      }
    }

    if (result?.status === 'sent') {
      log({ ...base, memberId: member.resourceId, name: member.name, status: 'sent', messageId: result.messageId, conversationId: result.conversationId });
      summary.sent++;
    } else if (result?.status === 'skipped') {
      log({ ...base, memberId: member.resourceId, name: member.name, status: 'skipped', outcome: result.outcome, reason: result.reason });
      summary.skipped++;
    } else {
      log({ ...base, memberId: member.resourceId, name: member.name, status: 'failed', reason: lastErr?.message ?? 'Unknown error' });
      summary.failed++;
      // Auth problems will fail every remaining row too: stop instead of burning the list.
      if (lastErr?.code === 'UNAUTHENTICATED' || lastErr?.code === 'FORBIDDEN' || lastErr?.code === 'invalid_grant') break;
    }
    await sleepImpl(delayMs);
  }
  return summary;
}
