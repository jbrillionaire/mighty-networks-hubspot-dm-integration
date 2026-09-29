/**
 * send-batch.js -- DM a CSV list of members, resumable, dry run by default
 * ------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Run locally:
 *   npm run send-batch -- --csv recipients.csv --template-file message.txt           (dry run)
 *   npm run send-batch -- --csv recipients.csv --template-file message.txt --send    (real)
 *
 * What it does:
 *   Reads recipients (column `recipient`: email or member ID, plus any columns
 *   the template uses), sends one DM each through src/batch.js, and appends
 *   every result to a log CSV. Re-running with the same --log skips everyone
 *   already logged as sent.
 *
 * Why it exists:
 *   See src/batch.js. The log is the safety net against DMing anyone twice,
 *   so keep it; it contains member emails and is gitignored for that reason.
 *
 * Flags:
 *   --csv            recipients file (required)
 *   --template-file  default message (a row's `message` column overrides it)
 *   --log            result log (default send-log.csv)
 *   --send           actually send; without it every row is a dry run
 *   --limit N        stop after N recipients (use --limit 1 --send for a first live test)
 *   --delay-ms N     pause between sends (default 3000)
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createClient } from '../src/graphql-client.js';
import { whoAmI } from '../src/direct-messages.js';
import { parseCsv, csvLine } from '../src/csv.js';
import { runBatch } from '../src/batch.js';

const { values } = parseArgs({
  options: {
    csv: { type: 'string' },
    'template-file': { type: 'string' },
    log: { type: 'string', default: 'send-log.csv' },
    send: { type: 'boolean', default: false },
    limit: { type: 'string' },
    'delay-ms': { type: 'string', default: '3000' },
  },
});
if (!values.csv) throw new Error('Pass --csv recipients.csv');

const rows = parseCsv(readFileSync(values.csv, 'utf8'));
const template = values['template-file'] ? readFileSync(values['template-file'], 'utf8') : '';
if (!template && !rows.every((r) => r.message)) throw new Error('Pass --template-file, or give every row a `message` column.');

const LOG_COLS = ['at', 'recipient', 'memberId', 'name', 'status', 'outcome', 'reason', 'messageId', 'conversationId'];
const alreadySent = new Set();
if (existsSync(values.log)) {
  for (const r of parseCsv(readFileSync(values.log, 'utf8'))) if (r.status === 'sent') alreadySent.add(r.recipient.toLowerCase());
} else {
  appendFileSync(values.log, csvLine(LOG_COLS));
}

const request = createClient(loadConfig());
const me = await whoAmI(request);
console.log(`${values.send ? 'SENDING' : 'DRY RUN'} as ${me.name}: ${rows.length} rows, ${alreadySent.size} already sent per ${values.log}\n`);

const summary = await runBatch({
  request, rows, template, alreadySent, send: values.send,
  limit: values.limit ? Number(values.limit) : Infinity,
  delayMs: Number(values['delay-ms']),
  log: (r) => {
    if (r.status !== 'dry-run') appendFileSync(values.log, csvLine(LOG_COLS.map((c) => r[c] ?? '')));
    const who = r.name ? `${r.name} <${r.recipient}>` : r.recipient;
    console.log(`[${r.status}] ${who}${r.reason ? ` - ${r.reason}` : ''}`);
    if (r.status === 'dry-run') console.log(`    ${r.text.replace(/\n/g, '\n    ')}\n`);
  },
});

console.log(`\nDone: ${JSON.stringify(summary)}`);
if (!values.send) console.log('Nothing was sent. Re-run with --send (try --limit 1 first).');
