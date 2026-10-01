<!--
  README.md -- Mighty Networks + HubSpot DM integration
  Author:  Jibril Sulaiman
  Created: 2026-09-28
  What:    What this integration is for, and the full guide to the Node
           DM sender. The HubSpot sync's guide is apps-script/dm-sync/README.md.
  Why:     The Mighty API sends every DM as a real person, never as "the
           brand". Most mistakes here are quiet ones: a DM that is skipped
           but counted as sent, a batch re-run that messages people twice,
           or outreach that goes out from the wrong account.
-->

# Mighty Networks + HubSpot DM integration

Handle [Mighty Networks](https://www.mightynetworks.com/) direct messages from
HubSpot. When a member DMs your community's Host account, the message shows up
on that member's HubSpot contact. When someone on your team types a reply in
HubSpot, it's delivered to the member as a Mighty DM from the Host account.
You can also send one-off or bulk DMs from a list.

## Why it exists

Member conversations in Mighty live in one person's inbox, cut off from the CRM
where your team tracks everyone else. That creates three problems:

- **Nobody else can see them.** A member asks about renewing, a refund or a class,
  and only whoever is logged in as the Host knows. Nothing reaches the contact
  record, reporting or follow-up workflows.
- **Replying means another login.** Staff who work in HubSpot have to switch into
  Mighty, as the right account, to answer.
- **Mighty doesn't make it easy to connect.** There's no webhook for DMs, and an API
  token can only read and send its own user's messages. There's no admin view of
  every inbox and no way to send "as the brand."

This integration closes that gap within those limits. It signs in once as the
Host account members already talk to, checks that inbox on a schedule, and sends
replies as that account.

## What's in it

| Part | What it does | Runs on |
|---|---|---|
| [DM sync with HubSpot](apps-script/dm-sync/README.md) | **Two-way sync.** Every 15 minutes, new DMs become notes on the member's HubSpot contact and a "last inbound" date is stamped. Every 5 minutes, replies typed into a contact property are sent as DMs, with a note recording what was sent. | Google Apps Script (no server) |
| [Direct messages](#direct-messages) | **Sending tool.** DM one member, or a CSV list with personalized fields, from a Host account. Dry run by default, resumable, never double-sends. | Node 20+ |

```text
 Member DMs the Host in Mighty ──► every 15 min ──► Note on the HubSpot contact
 Rep types a reply in HubSpot  ──► every 5 min  ──► DM from the Host in Mighty
```

**Built to fail safely.** Members notice mistakes in their inbox, so the code is
defensive where it matters:

- A reply is never sent twice.
- A DM Mighty declines to deliver, such as when a member has turned off private
  chat, is reported with the reason instead of counted as sent.
- Old messages aren't dumped into HubSpot on the first run.
- Nothing is written or sent until you've confirmed that Mighty members match the
  right HubSpot contacts.

**Requirements:** a Mighty Network on a plan with OAuth applications (Scale or
above), a Host account to send from, and for the HubSpot sync, a contact property
holding each member's Mighty member ID. No other dependencies.

---

## Table of contents

- [Direct messages](#direct-messages)
1. [How it works](#1-how-it-works)
2. [Requirements](#2-requirements)
3. [What's in this repo](#3-whats-in-this-repo)
4. [Setup, step by step](#4-setup-step-by-step)
   - [Step 1: Pick the sending account](#step-1-pick-the-sending-account)
   - [Step 2: Create the OAuth application](#step-2-create-the-oauth-application)
   - [Step 3: Configure the repo](#step-3-configure-the-repo)
   - [Step 4: Authorize once](#step-4-authorize-once)
   - [Step 5: Confirm who you'll send as](#step-5-confirm-who-youll-send-as)
   - [Step 6: Send a test DM to yourself on a second account](#step-6-send-a-test-dm-to-yourself-on-a-second-account)
   - [Step 7: Send to a list](#step-7-send-to-a-list)
5. [Using the code from your own project](#5-using-the-code-from-your-own-project)
6. [Why a DM might not be sent](#6-why-a-dm-might-not-be-sent)
7. [Mighty API behavior the docs don't spell out](#7-mighty-api-behavior-the-docs-dont-spell-out)
8. [When you don't need this](#8-when-you-dont-need-this)
9. [Troubleshooting](#9-troubleshooting)
10. [Testing](#10-testing)
11. [Security](#11-security)

---

## Direct messages

Send a private message to members from a Host account, one at a time or from a
CSV list, with per-member personalization:

```text
From: Community Team
To:   Alex Rivera

Hi Alex, it's been a little while since we've seen you in the community.

This week's live session is on Thursday. Your Annual membership includes it,
and I'd love to see you there.
```

The member gets it in their Mighty inbox with a normal push or email
notification, exactly as if the Host had typed it.

What you get on top of a raw API call:

- **Dry run by default.** Nothing is sent until you pass `--send`.
- **Skipped DMs are reported as skipped, with a reason.** For example, when a
  member has turned private chat off.
- **Resumable batches.** Every result is logged. Re-running skips everyone
  already sent, so a crash half way never leads to double messages.
- **No half-filled messages.** If a placeholder like `{{first_name}}` has no
  value for a row, that row is held back instead of sending "Hi ,".
- **Recipients by email or member ID.** Numeric IDs from Mighty webhooks or the
  Admin REST API work as-is.
- **Token refresh handled.** Including refresh-token rotation.

---

## 1. How it works

```text
 recipients.csv ──► send-batch.js ──► memberByEmail / member(id) ──► GlobalID
                          │
                          └──► createConversation(recipientIds, text,
                                                  reportSkipsAsOutcomes: true)
                                        │
                                        ├── outcome SENT      ──► log "sent"
                                        └── outcome SKIPPED_* ──► log "skipped" + reason
```

1. You authorize **once**, in a browser, as the Host account the messages should
   come from. The script stores an access token and a refresh token.
2. For each recipient, the code looks the member up to get their GraphQL
   **GlobalID**. The chat mutations don't accept emails.
3. It calls `createConversation`. That either starts a 1:1 DM or, if the two of
   you already have one, posts into it, so members never get a pile of
   duplicate threads.
4. Mighty answers with an `outcome`. Only `SENT` counts as sent.

---

## 2. Requirements

| Requirement | Why |
|---|---|
| A Mighty Network on the **Scale plan or above** (Scale, Growth, Mighty Pro) | OAuth applications, which the Mighty API requires, are only available there |
| A **Host** account to send from | Mighty skips DMs from non-Hosts (`SKIPPED_SENDER_NOT_HOST`), and Host scopes are needed to look members up |
| Private chat turned **on** for the Network | Otherwise every send is skipped (`SKIPPED_NETWORK_CHAT_DISABLED`) |
| Node.js **20+** | Built-in `fetch`, `node:test` and `parseArgs`; no packages to install |
| For email lookup: a plan with member-email visibility | Otherwise `memberByEmail` quietly returns nothing. Use member IDs instead. |

---

## 3. What's in this repo

```text
src/
  config.js            settings from env or .env; builds the OAuth and GraphQL URLs
  oauth.js             Authorization Code + PKCE, refresh, token file
  graphql-client.js    request() with User-Agent, error handling, auto refresh
  direct-messages.js   resolveRecipient, sendDirectMessage, replyInConversation, listDirectMessages
  batch.js             templated, resumable, throttle-aware batch sender
  csv.js               CSV parser/writer (handles commas and line breaks in messages)
  schema-check.js      the schema fields this repo depends on
scripts/
  authorize.js         one-time browser sign-in
  whoami.js            which account will the DMs come from?
  send-dm.js           send one DM
  send-batch.js        send to a CSV list
  check-schema.js      confirm the live schema still has every field used
examples/
  recipients.example.csv
  message.example.txt
docs/
  API-NOTES.md         operations, scopes, outcomes and quirks, verified against the live schema
test/
  direct-messages.test.js
```

---

## 4. Setup, step by step

Budget about an hour the first time. Steps 1 and 2 happen in your Mighty
Network's admin screens, Steps 3 to 7 in a terminal on your own computer.

You need:

- A Mighty Network on the **Scale plan or above** (OAuth applications only exist there).
- Two Mighty accounts you control: the **Host** account that will send, and an
  ordinary **member** account to receive test DMs.
- **Node.js 20 or newer.** Nothing else to install: the repo has no packages.

### Step 1: Pick the sending account

*About 5 minutes.*

Every DM goes out **as the account that signs in during Step 4**. Mighty has no
"send as the community" option and no admin mode that sends as someone else.

**1a. Choose the account.** Pick a Host account with a name and photo your
members recognize. A dedicated "Community Team" Host account works well: replies
land in an inbox your team can watch, and you don't DM members from someone's
personal profile.

**1b. Confirm it's a Host.**
1. Sign in to your Network as an admin and open **Admin** (the admin panel opens
   over the community, with a menu down the left side).
2. Open the members list (wording may differ: **Members** in the left menu) and
   search for the account.
3. Check that its role is **Host**.

> ⚠️ **A non-Host can't send, and can't even sign in.** Mighty skips every DM from
> a non-Host (`SKIPPED_SENDER_NOT_HOST`), and because this app requests a `host:`
> scope, a non-Host account can't finish the Step 4 sign-in at all.

**1c. Check private chat is on** for the Network and for the sending account
(wording and location may differ; it's in the Network's chat or messaging
settings, and in the account's own profile settings). With chat off, every send
comes back `SKIPPED_NETWORK_CHAT_DISABLED` or `SKIPPED_SENDER_CHAT_DISABLED`.

**1d. Find your mn.co subdomain.** Look at the address bar while you're in the
admin panel. If it reads `https://your-community.mn.co/admin/...`, your subdomain
is `your-community`. If your Network runs on a custom domain, the subdomain is
still in your Mighty account settings or your plan emails (wording may differ).
You can also confirm it in Step 3 with `npm run check-schema`, which fails on a
wrong subdomain.

✅ **Check:** you know which account sends, it's a **Host**, and you've written
down the subdomain.

### Step 2: Create the OAuth application

*About 10 minutes.*

**2a. Open OAuth Applications.**
1. In **Admin**, scroll the left menu to **Integrations** and expand it. You'll
   see **Admin API**, **MCP**, **Webhooks**, **OAuth Applications** and
   **Headless API**.
2. Click **OAuth Applications**. The page is titled **OAuth Applications**. On a
   new Network it says *"You haven't created an OAuth application yet."* The
   address is `https://<your community>/admin/oauth-applications`.
3. Click **New OAuth Application** (green button, top right).

**2b. Fill in the "New OAuth Application" dialog.** Scroll inside the dialog to
reach everything.

| Field | What to enter |
|---|---|
| **Application Name** \* | Something members recognize if they ever see the consent screen, e.g. `Community Messaging` |
| **Redirect URI** \* | `http://localhost:3000/oauth/callback`. The placeholder reads `https://myapp.com/oauth/callback`, and the hint says *"Multiple URIs can be separated by newlines"*. |
| **Host Scopes** | Check **`host:read:network_members`** (*"View members in the network"*). Leave `host:read:network_events`, `host:read:network_spaces`, `host:read:network_plans` and `host:read:network_posts` unchecked. |
| **Member Scopes** | Check **`read:userinfo`** (*"View your basic profile information"*). If the list includes **`write:chats`** (or `read:chats`), check it too. Leave `write:posts` and `write:comments` unchecked. |
| **Confidential client** | **Checked** if this runs on your own computer or a server you control (you'll get a Client Secret). The hint reads *"Uncheck for public clients (native/SPA apps). Public clients require PKCE for security."* The code uses PKCE either way. |
| **Skip consent screen** | Your choice. The hint reads *"Members authorizing this app skip the consent screen. Only enable for apps you trust to access your network."* Mighty's docs say chat scopes show the consent screen anyway. |

Click **Create**.

> ⚠️ **`write:chats` may not be in the list.** Mighty's docs say sending needs
> `write:chats`, but some Networks' dialogs offer only `read:userinfo`,
> `read:network`, `write:posts` and `write:comments` under **Member Scopes**. Reading
> and sending DMs has been seen working with such an app anyway. If it isn't
> offered, carry on, and in Step 3 remove `write:chats` from `MIGHTY_SCOPES`:
> requesting a scope the app doesn't have fails the sign-in with `invalid_scope`.
> Run the Explorer test in 2e to confirm chat works for your account before you
> rely on it.

**2c. Copy the credentials.** The dialog closes and the application appears as a
card on the **OAuth Applications** page, with a pencil (edit) and a trash
(delete) icon. The card shows:

- **Client ID:** click the copy icon next to it.
- **Client Secret:** masked. Click **Reveal**, then the copy icon.
- **Redirect URI**, **Type** (*Confidential* or *Public*), **Scopes**, and
  **Consent screen** (*Skipped* or shown).

Keep the Client ID and Secret somewhere private until Step 3. Both are 43
characters long.

> ⚠️ **Long values are cut off on screen, not in the copy.** The masked and
> narrow fields only *display* part of the value. Always use the copy icon, and
> don't retype them.

**2d. Check the card.** Click the pencil icon if anything is wrong. The Redirect
URI must be exactly `http://localhost:3000/oauth/callback`: no trailing slash,
same port, same path.

**2e. Optional: prove chat works in the Headless API Explorer.** This checks
that your account can read and send DMs through the API before you set up
anything else. Because it sends a real message, do it in a conversation with
your own test member account.

1. In **Admin → Integrations**, click **Headless API**. The page shows
   **GraphQL Endpoint** (`POST https://api.mn.co/networks/<number>/graphql`),
   **Headless API Usage**, and a note: *"API quotas are currently for
   informational purposes and are not yet enforced."*
2. Click **Headless API Explorer** (top right). The Explorer opens with an
   **OAuth Application** dropdown, a **Manage OAuth Applications** link, an
   *"Expires at …"* time and a **Refresh token** button. The query editor is on
   the left, with a green ▶ run button. Results appear on the right.
3. Pick your new application in the **OAuth Application** dropdown. If the
   token has expired, click **Refresh token**.
4. Replace the editor contents with this query and click ▶:

   ```graphql
   query { me { directMessages(first: 5) { nodes { id title } } } }
   ```

   You should see your DM conversations, each with an `id` and a `title`.
   (If you have no DMs yet, send one from the Mighty app to your test account
   first, then run it again.)
5. Copy the `id` of the conversation with your test account, and run:

   ```graphql
   mutation {
     createDirectMessage(input: { conversationId: "PASTE_ID", text: "<p>API test, please ignore</p>" }) {
       errors
       message { id textText }
     }
   }
   ```

✅ **Check (2e):** the result shows `"errors": []` and a `message` with an `id`.
The test account's inbox has the message.

> ⚠️ **Explorer errors seen in testing:**
> - `Field 'directMessage' doesn't exist on type 'CreateDirectMessagePayload'`
>   with code `undefinedField`: the payload field is `message`, not `directMessage`.
> - `createMessage` returns `NOT_FOUND` on a DM (the message text may be in
>   another language, e.g. *"Conversation introuvable"*): `createMessage` is for
>   *space* chats. DMs use `createDirectMessage` or `createConversation`.
> - Listing *space* messages (`Space.messages`) has returned
>   `INTERNAL_SERVER_ERROR`. DM messages are a different field and weren't affected.

✅ **Check:** the application card shows the scopes you checked and the exact
Redirect URI, and you have the Client ID (and Secret, if Confidential).

### Step 3: Configure the repo

*About 10 minutes.*

**3a. Check Node.** Open a terminal (PowerShell on Windows, Terminal on
macOS/Linux) and run:

```powershell
node --version
```

It must print `v20` or higher. If it doesn't, install the current LTS from
[nodejs.org](https://nodejs.org/) and open a new terminal.

**3b. Get the code.** Either clone it:

```powershell
git clone https://github.com/<you>/mighty-networks-hubspot-dm-integration.git
cd mighty-networks-hubspot-dm-integration
```

or, on the GitHub page, click **Code → Download ZIP**, unzip it, and `cd` into
the unzipped folder. You don't need to run `npm install`; there are no packages.

**3c. Run the tests** to confirm Node works in this folder. Nothing is sent to
Mighty:

```powershell
npm test
```

Every test should pass (`# fail 0` near the end).

**3d. Create your `.env` file** from the example:

```powershell
Copy-Item .env.example .env
notepad .env
```

(macOS/Linux: `cp .env.example .env`, then open `.env` in any editor.)

**3e. Fill in `.env`.** Each line is `NAME=value`, with no quotes and no spaces
around the `=`.

| Setting | Value |
|---|---|
| `MIGHTY_NETWORK` | Your **mn.co subdomain** from 1d, e.g. `your-community` for `your-community.mn.co`. Use this even if members visit a custom domain. Not a URL. |
| `MIGHTY_CLIENT_ID` | The Client ID from 2c |
| `MIGHTY_CLIENT_SECRET` | The Client Secret from 2c. **Leave it blank** for a Public application. |
| `MIGHTY_REDIRECT_URI` | `http://localhost:3000/oauth/callback`, exactly as on the application card |
| `MIGHTY_SCOPES` | The scopes you checked in 2b, separated by spaces. The default is `read:userinfo write:chats host:read:network_members`. **Remove `write:chats`** if the app doesn't have it. |
| `MIGHTY_USER_AGENT` | `your-app/1.0 (+https://example.com)`, with your own name and site. Mighty blocks requests without one. |
| `MIGHTY_TOKEN_FILE` | Leave as `.tokens.json` |

Save the file and close the editor.

**3f. Check the subdomain and the schema.** No token is needed yet:

```powershell
npm run check-schema
```

Runs [`scripts/check-schema.js`](scripts/check-schema.js).

✅ **Check:** it prints `Schema OK: every field this repo uses is present.`

| If you see | Fix |
|---|---|
| `MIGHTY_NETWORK must be the bare mn.co subdomain` | You entered a domain or URL. Use just `your-community`. |
| `Schema download failed: HTTP 404` | Wrong subdomain. Recheck 1d. |
| `Missing from the live schema: ...` | Mighty changed the API. Don't send until the code is updated. |

### Step 4: Authorize once

*About 5 minutes.*

**4a. Open a private browser window** (Chrome: **Ctrl+Shift+N**; Safari/Firefox:
**File → New Private Window**) and sign in to your Mighty Network **as the
sending account from Step 1**. A private window keeps you from approving as
whoever your normal browser is signed in as.

**4b. Start the sign-in script** in the terminal:

```powershell
npm run authorize
```

Runs [`scripts/authorize.js`](scripts/authorize.js).

It prints:

```text
Open this URL, sign in as the Host account DMs should come from, and approve:

https://your-community.mn.co/oauth/authorize?response_type=code&client_id=...&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Foauth%2Fcallback&scope=...&state=...&code_challenge=...&code_challenge_method=S256

Waiting for the redirect on http://localhost:3000/oauth/callback ...
```

Leave the terminal running.

**4c. Open the URL.** Copy the whole `https://...` line (it's long) and paste it
into the private window's address bar.

**4d. Approve.** If the consent screen appears, it names your application and
the permissions it asks for. Click the approve button (wording may differ). If
you checked **Skip consent screen** and the scopes allow it, Mighty sends you
straight on without a screen.

**4e. Watch the redirect.** The browser goes to
`http://localhost:3000/oauth/callback?code=...&state=...` and shows a plain page
reading **`Authorized. You can close this tab.`** The terminal prints:

```text
Saved tokens to C:\...\mighty-networks-hubspot-dm-integration\.tokens.json
Granted scopes: read:userinfo write:chats host:read:network_members
Next: npm run whoami
```

and the script exits.

✅ **Check:** `Granted scopes:` lists what you set in `MIGHTY_SCOPES`, and
`.tokens.json` now exists in the repo folder.

If `write:chats` wasn't granted, the script adds:
`Note: write:chats was not granted. DMs may still work on your Network; test with npm run send before relying on it.`
That's expected if your dialog didn't offer the scope. Step 6 proves whether
sending works.

> ⚠️ **What can go wrong here:**
>
> | You see | Cause | Fix |
> |---|---|---|
> | Browser shows `Authorization failed: invalid_scope` | `MIGHTY_SCOPES` asks for a scope the app doesn't have | Remove it from `.env` (usually `write:chats`), then `npm run authorize` again |
> | Mighty shows a redirect URI error, or `redirect_uri_mismatch` | `.env` and the application card differ by a character | Make them identical, including port and path |
> | Browser shows `State mismatch. Start again with npm run authorize.` | You opened a URL from an earlier run | Use the URL the *current* run printed |
> | `Token exchange failed: invalid_client` | Wrong or partly copied ID or secret, or a secret set for a Public app | Recopy with the copy icons. Leave the secret blank for Public apps. |
> | `EADDRINUSE` when the script starts | Something else is using port 3000 | Stop it, or change the port in **both** the application's Redirect URI and `MIGHTY_REDIRECT_URI` |
> | The sign-in page won't let you in | The account isn't a Host, and a `host:` scope was requested | Use a Host account (Step 1) |
>
> Authorization codes are single-use and expire within minutes. After any
> failure, start again from 4b to get a fresh one.

You won't need to do this again unless the refresh token is revoked or expires.
When that happens, scripts stop with `invalid_grant`. Run `npm run authorize`
again.

### Step 5: Confirm who you'll send as

*About 2 minutes.*

Run:

```powershell
npm run whoami
```

Runs [`scripts/whoami.js`](scripts/whoami.js).

```text
Sending as:   Community Team
GlobalID:     TWVtYmVyOjEyMzQ1
Resource ID:  12345
Scopes:       read:userinfo write:chats host:read:network_members
```

✅ **Check:** **Sending as** is the account from Step 1.

If it's anyone else, delete `.tokens.json` from the repo folder and repeat
Step 4, making sure the private window is signed in as the right account.

> ⚠️ `Mighty API returned non-JSON, HTTP 403` means `MIGHTY_USER_AGENT` is
> missing or empty. `No tokens found. Run: npm run authorize` means Step 4
> didn't finish.

### Step 6: Send a test DM to yourself on a second account

*About 5 minutes.*

Use the ordinary member account you control, **not** the sending account.
Messaging yourself is skipped (`SKIPPED_SELF_MESSAGE`).

**6a. Dry run.** Nothing is sent:

```powershell
npm run send -- --to test-member@example.com --text "Testing the DM integration.\nLine two."
```

Runs [`scripts/send-dm.js`](scripts/send-dm.js).

(The `--` after `npm run send` is needed so npm passes the flags to the script.
Type `\n` literally; the script turns it into a line break.)

```text
From: Community Team
To:   Test Member (67890)
Text:
Testing the DM integration.
Line two.

Dry run. Add --send to deliver it.
```

Check that **From** is the sending account and **To** is your test account.

If it stops with `No member found for "test-member@example.com" (or your token cannot look them up)`,
your plan or the member's privacy settings hide emails from the API. Use the
member's **numeric ID** instead: `--to 67890`. You can find it in the Admin
members list or in the member's profile address (wording may differ).

**6b. Send it for real.** Same command, plus `--send`:

```powershell
npm run send -- --to test-member@example.com --text "Testing the DM integration.\nLine two." --send
```

```text
Sent. Message <id> in conversation <id>
```

If it prints `Not sent: <reason> (<OUTCOME>)` instead, look the outcome up in
[section 6](#6-why-a-dm-might-not-be-sent).

**6c. Look at it in Mighty.** In the private window, sign out and sign in as the
test account (or use a second private window). Open your chats or messages.

✅ **Check:** the test account has the message from the sending account, with
**Line two.** on its own line. Running 6b again posts into the **same**
conversation rather than starting a new one.

`--to` also accepts a GlobalID. Repeat `--to` to start a group DM.

### Step 7: Send to a list

*About 15 minutes, plus sending time.*

**7a. Make the recipients CSV.** Copy [`examples/recipients.example.csv`](examples/recipients.example.csv)
to a new file, e.g. `recipients.csv`, and replace the rows. The file needs a
`recipient` column (email or numeric member ID), plus any columns your message
uses:

```csv
recipient,first_name,plan
alex@example.com,Alex,Annual
jordan@example.com,,Monthly
1234567,Sam,Monthly
```

If you edit it in Excel or Google Sheets, save or download it as **CSV**.

**7b. Write the message.** Copy [`examples/message.example.txt`](examples/message.example.txt)
to `message.txt` and edit it:

```text
Hi {{first_name}}, it's been a little while since we've seen you in the community.
```

- `{{first_name}}` uses the CSV column, and falls back to the first word of the
  member's Mighty profile name when the column is blank (Jordan above).
- `{{name}}` is the full Mighty profile name.
- Any other CSV column works, e.g. `{{plan}}`.
- A `message` column on a row overrides the template for that row.
- A blank line starts a new paragraph.

**7c. Dry run** and read every preview:

```powershell
npm run send-batch -- --csv recipients.csv --template-file message.txt
```

Runs [`scripts/send-batch.js`](scripts/send-batch.js).

```text
DRY RUN as Community Team: 3 rows, 0 already sent per send-log.csv

[dry-run] Alex Rivera <alex@example.com>
    Hi Alex, it's been a little while since we've seen you in the community.

[dry-run] Jordan Lee <jordan@example.com>
    Hi Jordan, it's been a little while since we've seen you in the community.

[failed] 1234567 - No member found (or lookup not permitted)

Done: {"sent":0,"skipped":0,"failed":1,"alreadySent":0,"dryRun":2}
Nothing was sent. Re-run with --send (try --limit 1 first).
```

Fix every `[failed]` row before sending:

| Reason | Fix |
|---|---|
| `No member found (or lookup not permitted)` | Wrong email or ID, or email lookup is refused. Use the numeric member ID. |
| `Missing value for {{plan}}` | That row has no value for a placeholder. Fill the cell or change the template. |
| `Row has no recipient` | Empty `recipient` cell |

Dry-run rows are **not** written to the log, so you can dry-run as often as you
like.

**7d. Send one** for real:

```powershell
npm run send-batch -- --csv recipients.csv --template-file message.txt --send --limit 1
```

The first line now reads `SENDING as ...`, and the row shows `[sent]`. Check
that member's message in Mighty if you can (or send the first one to your test
account by putting it first in the CSV).

**7e. Send the rest.** Same command, without `--limit`:

```powershell
npm run send-batch -- --csv recipients.csv --template-file message.txt --send
```

The member from 7d is skipped because the log already has them. The first line
says so: `... 3 rows, 1 already sent per send-log.csv`.

✅ **Check:** the final `Done:` line has `"sent"` equal to the number of members
you expected, and `send-log.csv` has one `sent` row per member.

Every result is appended to `send-log.csv`:

| Column | Meaning |
|---|---|
| `status` | `sent`, `skipped` (Mighty declined, with `outcome` and `reason`) or `failed` (lookup failed, missing placeholder value, or an error) |
| `memberId` | The member's numeric resource ID |
| `messageId`, `conversationId` | GlobalIDs of what was sent |

> ⚠️ **Keep the log. It's what prevents double sends.** If a run stops for any
> reason (a crash, a closed laptop, a throttle), run the **same command with the
> same log file** again and it picks up where it left off. For each new
> campaign, use a new log name, e.g. `--log send-log-october.csv`. Otherwise
> anyone who got campaign 1 is skipped for campaign 2.

Pacing: 3 seconds between sends by default (`--delay-ms` to change). When Mighty
answers `THROTTLED`, the sender waits 1, 2, 3, then 4 minutes before giving up on
that row. An authentication or permission error stops the whole run, since
every remaining row would fail the same way.

---

## 5. Using the code from your own project

```js
import { loadConfig } from './src/config.js';
import { createClient } from './src/graphql-client.js';
import { resolveRecipient, sendDirectMessage } from './src/direct-messages.js';

const request = createClient(loadConfig());

const member = await resolveRecipient(request, 'alex@example.com'); // or 1234567, or a GlobalID
if (!member) throw new Error('No such member');

const result = await sendDirectMessage(request, [member.id], 'Hi Alex!');
// { status: 'sent', outcome: 'SENT', conversationId, messageId, sentAt }
// { status: 'skipped', outcome: 'SKIPPED_RECIPIENT_CHAT_DISABLED', reason: 'Recipient has turned off private chat' }
```

The imports are [`src/config.js`](src/config.js), [`src/graphql-client.js`](src/graphql-client.js) and [`src/direct-messages.js`](src/direct-messages.js).

`createClient` accepts a `tokenStore: { load(), save(tokens) }` if you'd rather
keep tokens in a database or secret manager than in `.tokens.json`. Persist
every `save`: refresh tokens rotate.

Other helpers:

| Function | What it does |
|---|---|
| `replyInConversation(request, conversationId, text, { replyToId })` | Post into a known conversation, or into the thread under one message |
| `listDirectMessages(request, { first, after })` | The sending account's own DMs, newest first |
| `whoAmI(request)` | The member the token acts as |

---

## 6. Why a DM might not be sent

Mighty returns one of these instead of sending. The batch log shows the reason
in plain words.

| Outcome | What to do |
|---|---|
| `SKIPPED_RECIPIENT_CHAT_DISABLED` | The member turned private chat off. Respect it; reach them another way. |
| `SKIPPED_RECIPIENT_LIMITED_MEMBER` | Limited Members can't receive private chat. |
| `SKIPPED_SENDER_NOT_HOST` | Re-authorize with a Host account (Step 1). |
| `SKIPPED_SENDER_CHAT_DISABLED` | Turn private chat on for the sending account. |
| `SKIPPED_NETWORK_CHAT_DISABLED` | Turn private chat on for the Network. |
| `SKIPPED_SELF_MESSAGE` | The recipient is the sending account. |
| `SKIPPED_CONVERSATION_UNAVAILABLE` | The member left, or the conversation no longer exists. |

---

## 7. Mighty API behavior the docs don't spell out

The full list, with the exact operations and scopes, is in
[`docs/API-NOTES.md`](docs/API-NOTES.md). The ones that shape this code:

- **There is no brand or admin sender.** A token reaches only its own user's
  conversations, so outreach always comes from one real account.
- **The consent screen can't be skipped for chat scopes**, even on applications
  configured to skip it. There's no silent first authorization.
- **Requesting any `host:` scope blocks non-Hosts from signing in at all.**
- **GraphQL errors come back with HTTP 200.** Mutations also carry their own
  `errors` list. Both are checked.
- **No `User-Agent`, no API.** `api.mn.co` returns an HTML bot challenge with a 403.
- **`memberByEmail` returns `null` both for "no such member" and for "you're not
  allowed to see that"** (plan, role, or the member's email-sharing consent).
  Failed lookups are rate limited. Member IDs from Mighty webhooks or the Admin
  REST API are the more reliable key.
- **Member activity is a separate feature.** `Member.lastActiveAt` and
  `Membership.lastActiveAt` exist for Host tokens, but this module doesn't use
  them. If you target members by activity, build that list separately and hand
  it to `send-batch` as a CSV.

---

## 8. When you don't need this

Mighty's own **automations** have a *Send a direct message* action. If the
trigger lives inside Mighty (a member joins, buys a plan, gets a tag), an
automation is simpler and needs no code.

Use this repo when the audience or timing is decided **outside** Mighty: a CRM
list, a spreadsheet, a payment event from another system, or a one-off campaign
you want to review row by row before sending.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MIGHTY_NETWORK must be the bare mn.co subdomain` | A domain or URL in `MIGHTY_NETWORK` | Use just `my-community` |
| `redirect_uri_mismatch` | Registered URI differs by a character | Copy it exactly, including port and path |
| `invalid_scope` | App isn't allowed a requested scope | Add it to the OAuth application, or remove it from `MIGHTY_SCOPES` |
| `invalid_client` | Wrong ID/secret, or a secret sent for a Public app | Recheck; leave `MIGHTY_CLIENT_SECRET` blank for Public apps |
| `invalid_grant` | Refresh token revoked or expired | `npm run authorize` |
| `Mighty API returned non-JSON, HTTP 403` | No `User-Agent`, or the client is blocked | Set `MIGHTY_USER_AGENT` |
| `No member found` for an email you know exists | Refused lookup (plan, consent, token not a Host) | Use the member's numeric ID |
| Every row `skipped` with `SKIPPED_SENDER_NOT_HOST` | Authorized as a non-Host | Step 1, then Step 4 |
| `FORBIDDEN` | Token lacks the scope for the operation | Check `npm run whoami` scopes |
| `THROTTLED` repeatedly | Sending too fast | Raise `--delay-ms` |
| Error mentioning a missing field | Mighty changed the schema | `npm run check-schema` |

---

## 10. Testing

```powershell
npm test
```

22 unit tests with a fake API; nothing is sent to Mighty. They pin the failure
modes that matter: a skipped DM must never count as sent, a re-run must never
double-message, a half-filled template must never go out, a rotated refresh
token must be saved, and an auth failure must stop a batch.

```powershell
npm run check-schema
```

Runs [`scripts/check-schema.js`](scripts/check-schema.js).

Downloads your Network's public schema (no token) and confirms every type,
field and enum value this repo uses still exists. Run it before a large send.

---

## 11. Security

- **`.tokens.json` can read and send a real person's private messages.** It's
  gitignored, and on macOS/Linux it's written readable by your user only. Never commit it, paste it
  into chat tools, or copy it to shared drives.
- **`send-log.csv` and your recipient CSVs contain member emails.** They're
  gitignored; treat them as personal data.
- Keep the Client Secret in `.env` (gitignored) or a secret manager.
- [`authorize.js`](scripts/authorize.js) checks the OAuth `state` value on the redirect and uses PKCE, so
  a forged redirect can't plant someone else's token.
- To cut access: revoke the token at `/oauth/revoke`, remove the app under
  **Connected Apps** in the sending account's settings, or delete the OAuth
  application in Network Admin.
- Only message members who expect to hear from you, and honor
  `SKIPPED_RECIPIENT_CHAT_DISABLED`. It's the member saying no.
