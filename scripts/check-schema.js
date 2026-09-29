/**
 * check-schema.js -- confirm the live schema still has what this repo uses
 * ------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Run locally: `npm run check-schema`. No token needed.
 *
 * What it does:
 *   Downloads your Network's public SDL (GET api.mn.co/networks/<network>/graphql/schema)
 *   and checks that every type, field, input field and enum value this repo
 *   depends on is still present.
 *
 * Why it exists:
 *   Mighty deprecates fields with a removal date (for example
 *   PrivateMessage.user goes away on 2026-12-15). A rename shows up as a
 *   GraphQL error mid-batch; this check shows it before you send anything.
 */

import { loadConfig } from '../src/config.js';
import { findMissing } from '../src/schema-check.js';

const config = loadConfig();
const res = await fetch(`https://api.mn.co/networks/${config.network}/graphql/schema`, { headers: { 'User-Agent': config.userAgent } });
if (!res.ok) throw new Error(`Schema download failed: HTTP ${res.status}`);
const missing = findMissing(await res.text());
if (missing.length) { console.error(`Missing from the live schema: ${missing.join(', ')}`); process.exitCode = 1; }
else console.log('Schema OK: every field this repo uses is present.');
