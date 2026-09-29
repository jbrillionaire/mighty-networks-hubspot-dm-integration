<!--
  README.md -- Mighty DM <-> HubSpot sync: setup and operation
  Author:  Jibril Sulaiman
  Created: 2026-09-28
  What:    How to install, test and run the standalone "Mighty DM Sync"
           Apps Script project, step by step.
  Why:     Members' private messages are involved. Every step ends in a check,
           and the script itself refuses to write to HubSpot or send anything
           until the ID check and the baseline are done.
-->

# Mighty DM Sync

Two-way sync between the **Mighty Networks** DM inbox of one Host account and
**HubSpot** contacts, in Google Apps Script. No server, no webhook endpoint.

| Direction | What happens | How often |
|---|---|---|
| **Mighty to HubSpot** | Each new DM becomes a Note on the member's contact ("Mighty DM from Alex Rivera"), and `mn_dm_last_inbound_at` is stamped. Messages the Host types in the Mighty app are copied too. | every 15 min |
| **HubSpot to Mighty** | A rep types a reply into the contact's **Mighty DM reply** property. It goes out as a DM from the Host account, gets a Note ("Mighty DM sent by ... via HubSpot"), and the property clears. | every 5 min |

**Keep it in its own project.** It gets its own Apps Script project, Google Sheet,
Mighty sign-in and HubSpot key, separate from any other Mighty integration you
run, so each can be paused or rotated without breaking the other.

**Requires:** a Mighty Network on a plan with OAuth applications (Scale or above),
and a HubSpot number property `mn_member_id` on contacts that holds each member's
Mighty member id (the numeric `resourceId`, the same id the Admin API uses). A
roster sync or a Mighty webhook usually fills it.

---

## Files

| File | What it does |
|---|---|
| `Config.gs` | Network, sheet id, property names, limits |
| `Auth.gs` | One-time Mighty sign-in; token refresh with rotation |
| `Mighty.gs` | The Mighty API calls: inbox, messages, member lookup, send |
| `HubSpot.gs` | Contact lookup by `mn_member_id`, notes, property updates |
| `State.gs` | The sheet tabs: state, send ledger, logs |
| `Inbox.gs` | Mighty to HubSpot (`dmPollInbox`) |
| `Outbox.gs` | HubSpot to Mighty (`dmPollOutbox`) |
| `Setup.gs` | Checks, baseline, triggers, status |
| `tests/` | Local tests (`node --test tests/` from this folder), never pasted into Apps Script |

---

## Before you start: pick the sending account

Every synced DM is **this account's inbox**, and every reply is **sent as this
account**. A Mighty token only reaches its own user's DMs, so there is no brand-wide
or admin inbox.

It must be a **Host**, or Mighty skips every send (`SKIPPED_SENDER_NOT_HOST`).
A shared "Community Team" Host account works well; your own account works for testing.

---

## Setup

### Step 1: Create the sheet and the Apps Script project

1. Create a blank Google Sheet named **Mighty DM Sync**. Copy its id from the URL
   (the long string between `/d/` and `/edit`).
2. Go to [script.google.com](https://script.google.com/) > **New project**. Name it
   **Mighty DM Sync**.
3. Create one script file per `.gs` file here (`Config`, `Auth`, `Mighty`,
   `HubSpot`, `State`, `Inbox`, `Outbox`, `Setup`) and paste each file's full
   contents.
4. In `Config.gs`, set `DM_SPREADSHEET_ID` to the sheet id, and fill in `DM_NETWORK`, `DM_OAUTH_HOST`, `DM_REDIRECT_URI`, `DM_USER_AGENT` and `HS_PORTAL_ID`.
5. **Project Settings** (gear icon) > set **Time zone** to yours, and set `DM_TZ` in `Config.gs` to match.

> **Check:** Save. The editor shows no red errors.

### Step 2: Create the HubSpot service key

1. Open **Settings > Integrations > Service Keys** > **Create service key**.
2. Name: **Mighty DM Sync**. Scopes: `crm.objects.contacts.read` and
   `crm.objects.contacts.write`, nothing else.
3. Copy the key. In Apps Script **Project Settings > Script Properties**, add
   `DM_HS_TOKEN` = the key.

Use a **new** key, not one another integration already uses: sharing a key
means rotating it for one silently breaks the other.

### Step 3: Create the Mighty OAuth application

1. In Mighty, open **Admin > Integrations > OAuth Applications** and click
   **New OAuth Application**.
2. **Name:** `Mighty DM Sync`. Members may see this name on a consent screen.
3. **Redirect URI:** your community URL, e.g. `https://your-community.mn.co/`, exactly as in `DM_REDIRECT_URI`
4. **Scopes:** `host:read:network_members`, `read:userinfo`, `read:network`, plus
   `read:chats` and `write:chats` **if they're listed**. DM reads and replies have
   been seen working with an app that had no chat scope (some Networks' screens
   didn't offer them), so their absence doesn't necessarily block this.
5. **Confidential client:** on. Leave **Skip consent screen** off.
6. Copy the **Client ID** and **Client Secret** into Script Properties:
   `DM_CLIENT_ID`, `DM_CLIENT_SECRET`, and `DM_SCOPES` = the scopes you checked,
   separated by spaces.

> **Check:** run `dmCheckCreds`. Both lengths show 43.

### Step 4: Sign in as the sending account

1. Open a **private browser window** and sign in to Mighty as the account from
   "Before you start".
2. In Apps Script, run `dmLogAuthorizeUrl`. Open the URL it logs **in that private
   window** and approve.
3. You land on your redirect URI with `?code=...&state=...`. Copy both values.
4. In `Setup.gs`, temporarily add and run:

   ```javascript
   function once() { dmExchangeCode("PASTE_CODE", "PASTE_STATE"); }
   ```

   Then delete that function. Codes expire in minutes and work once.
5. Run `dmWhoAmI`.

> **Check:** it logs the sending account's name. If it's the wrong person, delete
> `DM_REFRESH_TOKEN` from Script Properties and repeat this step.

### Step 5: Create the two HubSpot contact properties

In HubSpot, **Settings > Properties > Contact properties > Create property**:

| Label | Internal name | Field type |
|---|---|---|
| Mighty DM reply | `mn_dm_reply` | Multi-line text |
| Mighty DM last inbound at | `mn_dm_last_inbound_at` | Date and time picker |

Put both in a "Mighty" group. The internal names must match exactly; a typo makes
the search return nothing, and replies sit unsent with no error.

### Step 6: Prove DM reads work

Run `dmPeekInbox`. It reads three DMs and their newest messages and writes nothing.

> **Check:** the log lists real conversations and says "N message(s) readable".
> Mighty has returned server errors on *space* chat message lists; this confirms
> *DM* message lists work for you. If it errors, stop here.

### Step 7: Confirm member ids match

Run `dmVerifyIdMapping`. For up to 10 DMs it logs the Mighty member, whether
their id resolves back to the same member, and a link to the HubSpot contact with
that `mn_member_id`.

> **Check:** open every HubSpot link. It must be the same person as the Mighty
> name. If all match, run `dmConfirmIdMapping`. **If any is wrong, stop:** notes
> would land on the wrong contacts and replies would go to the wrong members.

Until you confirm, both sync functions refuse to run.

### Step 8: Record where the inbox stands

Run `dmBaselineInbox`. Repeat until it logs **Baseline done**; big inboxes take
several runs. Only DMs that arrive **after** this point are copied, so years of
welcome messages don't land in HubSpot.

### Step 9: Test end to end

Use a second, ordinary member account you control, one that has a HubSpot contact
with its `mn_member_id` filled in.

1. **Inbound:** from the test account, DM the sending account "inbound test". Run
   `dmPollInbox`.
   > **Check:** the test contact's timeline has a note "Mighty DM from ..." with
   > the text, and **Mighty DM last inbound at** is set. The **DM Log** tab has a row.
2. **Outbound:** on the test contact in HubSpot, set **Mighty DM reply** to
   "outbound test". Run `dmPollOutbox`.
   > **Check:** the test account's Mighty inbox has the message from the sending
   > account. The contact has a note "Mighty DM sent by ... via HubSpot", and the
   > reply property is empty again.
3. Run `dmPollInbox` again.
   > **Check:** no second note for "outbound test".

### Step 10: Turn it on

Run `dmInstallTriggers`: inbox every 15 minutes, outbox every 5. Run `dmStatus`
any time to see what's set up. `dmRemoveTriggers` stops both and keeps all state.

---

## Using it

**Answering a DM in HubSpot:** open the contact, type into **Mighty DM reply**,
save. Leave a blank line between paragraphs. It goes out within about 5 minutes,
then the property clears and a note records exactly what was sent.

**Starting a conversation:** same thing. If the member has no DM thread with the
sending account yet, one is created.

**A useful view:** contacts where **Mighty DM last inbound at** is in the last 7
days, sorted newest first. Those are the members who wrote in recently.

**When a reply isn't sent,** the contact gets a note "Mighty DM NOT sent (...)"
with the reason, the text is kept in the note, and the property clears:

| Reason | What to do |
|---|---|
| Member has turned off private chat | Reach them another way |
| Member is a Limited Member | Private chat doesn't apply to them |
| Sending account is not a Host | Re-sign in as a Host (Step 4) |
| Contact has no mn_member_id | Fill it in (the roster sync normally does), then retype |
| A previous run stopped mid-send | Check the Mighty thread; retype only if it isn't there |

---

## How it avoids the mistakes members would notice

- **No double sends.** Each reply is keyed to the moment it was typed (HubSpot's
  timestamp for that edit), not its wording, and logged as "sending" before the
  API call. A reply already sent is never sent again, even if clearing the
  property fails. If a run dies mid-send, the reply is not retried
  automatically; the rep is asked to check.
- **No duplicate notes.** Each conversation's newest copied message is recorded
  after every conversation, and replies sent from HubSpot are skipped when the
  inbox sync sees them come back.
- **No missed messages.** If a run is cut short or crashes, the next run scans the
  whole inbox once instead of stopping early.
- **No history dump.** Nothing before the baseline is copied.
- **No wrong recipients.** Nothing is written or sent until a person has checked
  real id matches (Step 7).
- **Mighty staff/test accounts** (`@mightynetworks.com`, `tfbnw.net`) are ignored.

---

## Limits

- **One inbox.** Only the sending account's DMs. A second Host inbox needs a
  second copy of this project with its own sign-in.
- **1:1 DMs only.** Group DMs are skipped and noted once in the DM Log.
- **Text only.** Attachments and reactions aren't copied; the note keeps the text.
- **Up to 100 new messages per conversation per run.** More than that logs a warning.
- **Latency:** up to 15 minutes in, 5 minutes out. Mighty has no DM webhook.
- **Quotas:** Mighty's Headless API page says quotas "are currently for
  informational purposes and are not yet enforced." If that changes, lengthen the
  trigger intervals.

---

## Sheet tabs

| Tab | What it holds |
|---|---|
| `DM Log` | Every message handled, both directions, with the HubSpot note id |
| `DM Unmatched` | DMs from members with no HubSpot contact, text included |
| `_dm_state` (hidden) | Per conversation: newest message copied |
| `_dm_outbox` (hidden) | Every reply's status: sending / sent / skipped / failed / unknown |

Don't edit the hidden tabs by hand. Deleting `_dm_outbox` removes the double-send
protection for anything in flight.

---

## Troubleshooting

| Log says | Cause | Fix |
|---|---|---|
| `Blocked: run dmVerifyIdMapping()` | Step 7 not done | Do Step 7 |
| `Blocked: run dmBaselineInbox()` | Step 8 not finished | Run it until "Baseline done" |
| `Mighty token refresh failed ... invalid_grant` | Sign-in revoked or expired | Redo Step 4 |
| `invalid_client` | Wrong or truncated client id/secret | `dmCheckCreds`, re-copy them |
| `HubSpot 401/403` | `DM_HS_TOKEN` wrong or missing a scope | Step 2 |
| `Mighty returned non-JSON, HTTP 403` | Blocked request | Check `DM_USER_AGENT` in Config |
| `did not resolve as a DirectMessage` | Mighty changed the DM type | Rerun `dmPeekInbox`; recheck the schema |
| Replies never send, no error | Property internal name typo | Step 5 names must match exactly |
| `WARNING: N+ contacts share mn_member_id` | Duplicate contacts | Merge them in HubSpot |

**Security:** `DM_REFRESH_TOKEN` can read and send this account's private messages.
It lives only in Script Properties. Never paste it anywhere. To cut access, delete
the OAuth application in Mighty Admin, or remove it under the sending account's
Connected Apps.
