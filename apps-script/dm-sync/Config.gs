/**
 * Config.gs -- settings for the Mighty DM <-> HubSpot sync
 * --------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  Its OWN Apps Script project ("Mighty DM Sync"), bound to nothing,
 *          pointed at its OWN Google Sheet. Keep it out of any other Mighty
 *          integration project: separate tokens, triggers and state mean one can
 *          be paused, rotated or broken without touching the other.
 *
 * What it does:
 *   Holds every constant the other files read. Secrets are NOT here -- they live
 *   in Project Settings > Script Properties (see README.md, step 3).
 *
 * Why it exists:
 *   One place to change the network, the sheet or a HubSpot property name.
 *   A property name that differs by one character from HubSpot fails silently:
 *   the search just returns nothing, and replies sit unsent.
 */

// Your Mighty network. Numeric id from Admin > Integrations > Headless API.
const DM_NETWORK      = "YOUR_NETWORK_ID";   // numeric id, or the mn.co subdomain
const DM_GRAPHQL_URL  = "https://api.mn.co/networks/" + DM_NETWORK + "/graphql";

// OAuth lives on the community host, not api.mn.co. A custom domain can work;
// if /oauth/authorize 404s on it, use "https://<subdomain>.mn.co".
const DM_OAUTH_HOST   = "https://your-community.mn.co";

// Must match the Redirect URI on the "Mighty DM Sync" OAuth app exactly.
// Any page you control works: you copy the ?code= value out of the address bar.
const DM_REDIRECT_URI = "https://your-community.mn.co/";

// Mighty rejects requests with no User-Agent (HTML 403 challenge).
const DM_USER_AGENT   = "mighty-dm-sync/1.0 (+https://example.com)";

// The DM sync's own sheet -- never shared with another integration.
// Create a blank Google Sheet, paste its id here (the long string in its URL).
const DM_SPREADSHEET_ID = "PASTE_DM_SHEET_ID";

// Tabs the script creates and owns in that sheet.
const DM_STATE_TAB     = "_dm_state";     // per-conversation high-water mark (hidden)
const DM_OUTBOX_TAB    = "_dm_outbox";    // send ledger that stops double sends (hidden)
const DM_LOG_TAB       = "DM Log";        // human-readable record of every message handled
const DM_UNMATCHED_TAB = "DM Unmatched";  // DMs from members with no HubSpot contact

// HubSpot contact properties. Create them before the first run (README, step 5).
const HS_MEMBER_ID_PROP    = "mn_member_id";           // existing number property, set by the roster sync
const HS_REPLY_PROP        = "mn_dm_reply";            // NEW multi-line text: a rep types a reply here
const HS_LAST_INBOUND_PROP = "mn_dm_last_inbound_at";  // NEW date-time: when the member last DM'd us

const HS_API = "https://api.hubapi.com";
const HS_PORTAL_ID = "YOUR_PORTAL_ID";   // for record links in logs only

// Paging and safety limits.
const DM_INBOX_PAGE        = 25;   // conversations per page (schema max 50)
const DM_MESSAGES_PAGE     = 25;   // messages per page (nested cap 25)
const DM_MAX_MESSAGE_PAGES = 4;    // up to 100 new messages per conversation per run
const DM_OUTBOX_BATCH      = 20;   // replies sent per run
const DM_SEND_PAUSE_MS     = 1500; // between sends

// Mighty seeds every network with staff/test accounts. Never DM or log them.
const DM_EXCLUDE_EMAIL_RE = /@(mightynetworks\.com|tfbnw\.net)$/i;

// Display timezone for notes and the log.
const DM_TZ = "America/New_York";
