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

### Step 1: Pick the sending account

Every message goes out **as the account that signs in during Step 4**. Mighty
has no "send as the community" option, and no admin mode that sends as someone
else.

Pick a **Host** account with a name and photo your members recognize. A
dedicated "Community Team" Host account works well: replies land in an inbox
your team can watch, and you avoid DMing from someone's personal profile.

> **Check:** in Network Admin > Members, the account's role is **Host**.

### Step 2: Create the OAuth application

1. Sign in to your Network as a Host and open **Network Admin**.
2. Go to **Integrations > OAuth Applications > New OAuth Application**.
3. **Name:** something members will recognize on the consent screen, e.g.
   "Community Messaging".
4. **Client type:**
   - **Confidential** if this runs on your machine or a server you control. You
     get a Client Secret.
   - **Public** if you can't keep a secret. PKCE is used either way.
5. **Redirect URI:** `http://localhost:3000/oauth/callback`. Mighty accepts plain
   `http` only for `localhost`.
6. **Scopes:**

   | Scope | Needed for |
   |---|---|
   | `write:chats` | Sending DMs (includes `read:chats`) |
   | `host:read:network_members` | Looking up recipients by email or member ID |
   | `read:userinfo` | `whoami`, and plain email addresses in lookups |

7. Save, and copy the **Client ID** (and **Client Secret** if confidential).

> **Check:** the application shows those three scopes and the exact redirect URI.
>
> **If `write:chats` isn't in the scope list,** don't stop yet. Mighty's docs now
> say chat needs `read:chats` / `write:chats`, but some Networks' OAuth screens have
> offered only `read:userinfo`, `read:network`, `write:posts` and `write:comments`
> under Member Scopes, and reading and replying to DMs has been seen working with
> such an app anyway. Leave `write:chats` out of `MIGHTY_SCOPES` (an unoffered scope
> fails with `invalid_scope`), run the Explorer test below, then Step 6. If sends
> fail with `FORBIDDEN`, ask Mighty support which scope authorizes chat for your
> Network.
>
> **Explorer test (no application needed):** open
> `https://<subdomain>.mn.co/admin/headless-api/explorer` as a Host. It mints a
> short-lived token that holds every scope. Run `query { me { directMessages(first: 5)
> { nodes { id title } } } }`, copy a conversation `id`, then run:
>
> ```graphql
> mutation {
>   createDirectMessage(input: { conversationId: "PASTE_ID", text: "<p>API test</p>" }) {
>     errors
>     message { id textText }
>   }
> }
> ```
>
> `errors: []` with a `message` means chat works for this account. Note the payload
> field is `message`; asking for `directMessage` fails with `undefinedField`.
> `redirect_uri_mismatch` later almost always means a trailing slash or port
> doesn't match.

### Step 3: Configure the repo

```powershell
git clone https://github.com/<you>/mighty-networks-hubspot-dm-integration.git
cd mighty-networks-hubspot-dm-integration
Copy-Item .env.example .env
notepad .env
```

(macOS/Linux: `cp .env.example .env` and edit it with any editor.)

Fill in:

| Setting | Value |
|---|---|
| `MIGHTY_NETWORK` | Your **mn.co subdomain**, e.g. `my-community` for `my-community.mn.co`. Use this even if members visit a custom domain. |
| `MIGHTY_CLIENT_ID` | From Step 2 |
| `MIGHTY_CLIENT_SECRET` | From Step 2, or blank for a Public application |
| `MIGHTY_REDIRECT_URI` | Exactly what you registered |
| `MIGHTY_USER_AGENT` | `your-app/1.0 (+https://your-site.example)`. Mighty blocks requests without one. |

> **Don't know your subdomain?** Open Network Admin; the admin URL is on
> `<subdomain>.mn.co`. Or run `npm run check-schema`: a wrong subdomain fails there.

### Step 4: Authorize once

```powershell
npm run authorize
```

1. The script prints a URL. Open it in a browser **signed in as the sending account
   from Step 1**. A private window avoids signing in with the wrong profile.
2. Approve the consent screen. Chat scopes always show it; this is expected.
3. The browser shows "Authorized", and the script saves `.tokens.json`.

> **Check:** the script prints `Granted scopes:` including `write:chats`. If a
> scope is missing, the account isn't a Host or the application doesn't allow
> that scope.

You won't need to do this again unless the refresh token is revoked or expires.
When that happens, scripts stop with `invalid_grant`; run `npm run authorize` again.

### Step 5: Confirm who you'll send as

```powershell
npm run whoami
```

```text
Sending as:   Community Team
GlobalID:     TWVtYmVyOjEyMzQ1
Resource ID:  12345
Scopes:       read:userinfo write:chats host:read:network_members
```

If that isn't the account you meant, delete `.tokens.json` and repeat Step 4.

### Step 6: Send a test DM to yourself on a second account

Use a second, ordinary member account you control, not the sending account.
Messaging yourself is skipped (`SKIPPED_SELF_MESSAGE`).

Dry run first:

```powershell
npm run send -- --to test-member@example.com --text "Testing the DM integration.\nLine two."
```

```text
From: Community Team
To:   Test Member (67890)
Text:
Testing the DM integration.
Line two.

Dry run. Add --send to deliver it.
```

Then send it for real:

```powershell
npm run send -- --to test-member@example.com --text "Testing the DM integration.\nLine two." --send
```

> **Check:** the test account's Mighty inbox has the message from the sending
> account, with the line break intact.

`--to` also accepts a numeric member ID or a GlobalID. Repeat `--to` to start a
group DM.

### Step 7: Send to a list

1. Make a CSV with a `recipient` column (email or member ID) and any columns your
   message uses. See [`examples/recipients.example.csv`](examples/recipients.example.csv):

   ```csv
   recipient,first_name,plan
   alex@example.com,Alex,Annual
   jordan@example.com,,Monthly
   1234567,Sam,Monthly
   ```

2. Write the message with `{{placeholders}}`. See [`examples/message.example.txt`](examples/message.example.txt):

   ```text
   Hi {{first_name}}, it's been a little while since we've seen you in the community.
   ```

   - `{{first_name}}` uses the CSV column, and falls back to the first word of the
     member's Mighty profile name when the column is blank (Jordan above).
   - `{{name}}` is the full Mighty profile name.
   - Any other CSV column works, e.g. `{{plan}}`.
   - A `message` column on a row overrides the template for that row.

3. **Dry run** and read every preview:

   ```powershell
   npm run send-batch -- --csv recipients.csv --template-file message.txt
   ```

4. **Send one** for real:

   ```powershell
   npm run send-batch -- --csv recipients.csv --template-file message.txt --send --limit 1
   ```

5. **Send the rest.** Same command, without `--limit`. The member you just sent to
   is skipped because they're already in the log:

   ```powershell
   npm run send-batch -- --csv recipients.csv --template-file message.txt --send
   ```

Every result is appended to `send-log.csv`:

| Column | Meaning |
|---|---|
| `status` | `sent`, `skipped` (Mighty declined, with `outcome` and `reason`) or `failed` (lookup failed, missing placeholder value, or an error) |
| `memberId` | The member's numeric resource ID |
| `messageId`, `conversationId` | GlobalIDs of what was sent |

**Keep the log.** It is what prevents double sends. If a run stops for any
reason, run the same command again with the same `--log` file. Use a new log
file name for each new campaign, or a member who got campaign 1 will be skipped
for campaign 2.

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
- `authorize.js` checks the OAuth `state` value on the redirect and uses PKCE, so
  a forged redirect can't plant someone else's token.
- To cut access: revoke the token at `/oauth/revoke`, remove the app under
  **Connected Apps** in the sending account's settings, or delete the OAuth
  application in Network Admin.
- Only message members who expect to hear from you, and honor
  `SKIPPED_RECIPIENT_CHAT_DISABLED`. It's the member saying no.
