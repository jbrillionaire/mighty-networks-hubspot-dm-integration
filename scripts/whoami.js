/**
 * whoami.js -- confirm which account the stored token will send DMs as
 * --------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Run locally after authorize: `npm run whoami`.
 *
 * What it does:
 *   Calls `me` and prints the member's name, GlobalID and resource ID, and
 *   the scopes stored with the token.
 *
 * Why it exists:
 *   Every DM goes out as whoever signed in during authorize. Signing in with
 *   the wrong browser profile sends member outreach from a personal account.
 *   Check this before the first real send.
 */

import { loadConfig } from '../src/config.js';
import { createClient } from '../src/graphql-client.js';
import { loadTokens } from '../src/oauth.js';
import { whoAmI } from '../src/direct-messages.js';

const config = loadConfig();
const request = createClient(config);
const me = await whoAmI(request);
const tokens = loadTokens(config.tokenFile);

console.log(`Sending as:   ${me.name}`);
console.log(`GlobalID:     ${me.id}`);
console.log(`Resource ID:  ${me.resourceId}`);
console.log(`Scopes:       ${tokens?.scope ?? '(unknown)'}`);
