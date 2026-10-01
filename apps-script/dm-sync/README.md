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
| [`Config.gs`](Config.gs) | Network, sheet id, property names, limits |
| [`Auth.gs`](Auth.gs) | One-time Mighty sign-in; token refresh with rotation |
| [`Mighty.gs`](Mighty.gs) | The Mighty API calls: inbox, messages, member lookup, send |
| [`HubSpot.gs`](HubSpot.gs) | Contact lookup by `mn_member_id`, notes, property updates |
| [`State.gs`](State.gs) | The sheet tabs: state, send ledger, logs |
| [`Inbox.gs`](Inbox.gs) | Mighty to HubSpot (`dmPollInbox`) |
| [`Outbox.gs`](Outbox.gs) | HubSpot to Mighty (`dmPollOutbox`) |
| [`Setup.gs`](Setup.gs) | Checks, baseline, triggers, status |
| [`tests/`](tests/) | Local tests (`node --test tests/` from this folder), never pasted into Apps Script |

---

## Before you start: pick the sending account

Every synced DM is **this account's inbox**, and every reply is **sent as this
account**. A Mighty token only reaches its own user's DMs, so there is no brand-wide
or admin inbox.

It must be a **Host**, or Mighty skips every send (`SKIPPED_SENDER_NOT_HOST`).
A shared "Community Team" Host account works well; your own account works for testing.

---

## Setup

Budget about 90 minutes. You'll work in four places: Google Sheets, the Apps
Script editor, HubSpot settings, and your Mighty Network's admin panel.

You need:

- A Google account that will own the script and the sheet. Triggers run as this
  account.
- HubSpot permission to create service keys and contact properties (usually a
  Super Admin).
- A Mighty Network on the **Scale plan or above**, the **Host** account from
  "Before you start", and an ordinary member account you control for testing.
- The contact property `mn_member_id` already filled in for your members.

### How to work in the Apps Script editor

Every step below says "run" a function. In the editor that always means:

1. **Open the file** that contains the function, by clicking it in the **Files**
   list on the left. The function dropdown only lists functions in the file
   that's open. Functions whose names end in `_` (like `dmMe_`) are helpers and
   never appear in the dropdown.
2. **Save** first if the title bar shows **Unsaved changes** (**Ctrl+S**, or the
   disk icon in the toolbar).
3. Pick the function in the dropdown in the toolbar (between **Debug** and
   **Execution log**).
4. Click **▷ Run**. The **Execution log** panel opens under the code. It starts
   with a yellow **Notice** row, *"Execution started"*, then one **Info** row per
   log line, and ends with **Notice** *"Execution completed"*. While it runs, a
   **Stop** button replaces Run.
5. A failure is a red **Error** row with the message, followed by the file and
   line it came from (e.g. `dmExchangeCode @ Auth.gs:62`).

The left rail of the editor has six icons, top to bottom: **Overview** (ⓘ),
**Editor** (`<>`), **Project history**, **Triggers** (alarm clock),
**Executions** (list with a ▶) and **Project Settings** (gear).

| File | Functions you'll run from it |
|---|---|
| [`Auth.gs`](Auth.gs) | `dmCheckCreds`, `dmLogAuthorizeUrl` |
| [`Setup.gs`](Setup.gs) | `dmWhoAmI`, `dmPeekInbox`, `dmVerifyIdMapping`, `dmConfirmIdMapping`, `dmBaselineInbox`, `dmInstallTriggers`, `dmRemoveTriggers`, `dmStatus`, plus the temporary `once` in Step 4 |
| [`Inbox.gs`](Inbox.gs) | `dmPollInbox` |
| [`Outbox.gs`](Outbox.gs) | `dmPollOutbox` |
| [`Config.gs`](Config.gs), [`Mighty.gs`](Mighty.gs), [`HubSpot.gs`](HubSpot.gs), [`State.gs`](State.gs) | none (the dropdown shows **No functions**) |

### Step 1: Create the sheet and the Apps Script project

*About 20 minutes.*

**1a. Create the sheet.**
1. Go to [sheets.new](https://sheets.new) (or Google Drive → **New → Google
   Sheets → Blank spreadsheet**), signed in as the Google account that will own
   the sync.
2. Click **Untitled spreadsheet** at the top left and rename it `Mighty DM Sync`.
3. Copy the sheet's **id** from the address bar: the long string between `/d/`
   and `/edit`.

   ```
   https://docs.google.com/spreadsheets/d/1AbC...xYz/edit#gid=0
                                          └──── id ────┘
   ```

Leave the default tab alone. The script creates its own tabs (`DM Log`,
`DM Unmatched` and two hidden ones) the first time it needs them.

> ⚠️ **Use a new sheet, not one another integration writes to.** The script
> owns every tab it creates, and sharing a sheet makes it easy to delete the
> hidden `_dm_outbox` tab that prevents double sends.

**1b. Create the Apps Script project.**
1. Go to [script.google.com](https://script.google.com/) and click **New
   project** (top left). The editor opens on a project called **Untitled
   project** with one file, **Code.gs**, containing an empty `myFunction`.
2. Click **Untitled project** at the top, type `Mighty DM Sync`, and click
   **Rename**.

This is a **standalone** project, not one opened from the sheet's **Extensions →
Apps Script** menu. It finds the sheet by the id you copied.

**1c. Turn `Code.gs` into `Config.gs`.**
1. In the **Files** list, hover over **Code.gs**, click its **⋮** menu, and
   choose **Rename**.
2. Type `Config` and press **Enter**. The editor adds `.gs` itself, so don't
   type it. (If you type `Config.gs` you get `Config.gs.gs`.)
3. Click in the code area, select everything (**Ctrl+A**), and delete it.
4. Open [`apps-script/dm-sync/Config.gs`](Config.gs) in this repo. On GitHub,
   use the **Copy raw file** button (or **Raw**, then select all). Paste
   **all** of it into the empty editor.

**1d. Add the other seven files**, in this order. Type each name without `.gs`; the
editor adds it.

1. **Auth** (one-time Mighty sign-in; token refresh with rotation): click **+** next to **Files**, choose **Script**, type `Auth` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/Auth.gs`](./Auth.gs).
2. **Mighty** (the Mighty API calls: inbox, messages, member lookup, send): click **+** next to **Files**, choose **Script**, type `Mighty` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/Mighty.gs`](./Mighty.gs).
3. **HubSpot** (contact lookup by `mn_member_id`, notes, property updates): click **+** next to **Files**, choose **Script**, type `HubSpot` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/HubSpot.gs`](./HubSpot.gs).
4. **State** (the sheet tabs: state, send ledger, logs): click **+** next to **Files**, choose **Script**, type `State` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/State.gs`](./State.gs).
5. **Inbox** (Mighty to HubSpot, `dmPollInbox`): click **+** next to **Files**, choose **Script**, type `Inbox` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/Inbox.gs`](./Inbox.gs).
6. **Outbox** (HubSpot to Mighty, `dmPollOutbox`): click **+** next to **Files**, choose **Script**, type `Outbox` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/Outbox.gs`](./Outbox.gs).
7. **Setup** (checks, baseline, triggers, status): click **+** next to **Files**, choose **Script**, type `Setup` and press **Enter**. Select all and delete the empty `function myFunction() {}`, then paste **all** of [`apps-script/dm-sync/Setup.gs`](./Setup.gs).

Don't paste anything from [`tests/`](tests/) or this README into Apps Script.

**1e. Fill in [`Config.gs`](Config.gs).** Open **Config.gs** and replace the placeholder
values. Keep the quotes.

| Constant | What to put there | Where to find it |
|---|---|---|
| `DM_NETWORK` | Your Network's numeric id, e.g. `"1234567"` | Mighty **Admin → Integrations → Headless API**. The **GraphQL Endpoint** box shows `https://api.mn.co/networks/1234567/graphql`. Copy the number. |
| `DM_OAUTH_HOST` | Your community's address with no trailing slash, e.g. `"https://your-community.mn.co"` | Your browser's address bar on the community. A custom domain has worked. If `/oauth/authorize` gives a 404 there, use `https://<subdomain>.mn.co`. |
| `DM_REDIRECT_URI` | A page on your community, e.g. `"https://your-community.mn.co/"` | You'll register exactly this in Step 3. It only has to load: you copy the code out of the address bar. |
| `DM_USER_AGENT` | `"mighty-dm-sync/1.0 (+https://example.com)"` with your own site | Anything descriptive. Mighty blocks requests without one. |
| `DM_SPREADSHEET_ID` | The sheet id from 1a | |
| `HS_PORTAL_ID` | Your HubSpot account id, e.g. `"12345678"` | The number in any HubSpot address, e.g. `app.hubspot.com/contacts/12345678/...`. Only used to build links in the log. |
| `DM_TZ` | Your time zone as an IANA name, e.g. `"America/New_York"` | Used for times in notes and the log |

Leave the property names (`HS_MEMBER_ID_PROP`, `HS_REPLY_PROP`,
`HS_LAST_INBOUND_PROP`) as they are unless your HubSpot uses different internal
names. The paging and safety limits can stay at their defaults.

> ⚠️ **`DM_REDIRECT_URI` must match the Mighty application character for
> character, trailing slash included.** `https://your-community.mn.co/` and
> `https://your-community.mn.co` are different URIs to OAuth.

**1f. Save.** Press **Ctrl+S**. **Unsaved changes** disappears from the title
bar.

**1g. Set the project's time zone.**
1. Click **Project Settings** (gear, bottom of the left rail).
2. Under **General settings**, set **Time zone** to the same zone as `DM_TZ`
   (wording may differ). Trigger times follow this setting.
3. Make sure the **Chrome V8 runtime** option is checked (wording may differ).
   New projects have it on by default, and the code needs it.

✅ **Check:** the **Files** list shows exactly eight files: [`Config.gs`](Config.gs),
[`Auth.gs`](Auth.gs), [`Mighty.gs`](Mighty.gs), [`HubSpot.gs`](HubSpot.gs), [`State.gs`](State.gs), [`Inbox.gs`](Inbox.gs), [`Outbox.gs`](Outbox.gs),
[`Setup.gs`](Setup.gs). None shows a red error marker, and the title bar doesn't say
**Unsaved changes**.

### Step 2: Create the HubSpot service key

*About 10 minutes.*

**2a. Open Service Keys.** In HubSpot, click the **Settings** gear in the top
bar. In the left menu, open the service key list (wording and location may
differ: **Integrations → Service Keys**, or **Development → Keys → Service
Keys**). The page is titled **Service Keys**, with a table of **Name**, **Last
updated** and **Service key ID**.

> If you land on **Private Apps** and see *"Your private apps have moved"*, or a
> **Create Legacy App** dialog saying *"Service Keys are the better path"*,
> click **Use Service Keys instead**. Don't create a legacy private app.

**2b. Create the key.**
1. Click **Create service key**. The page is titled **Create Service Key**.
2. **Name:** `Mighty DM Sync`. (*"This name will appear in some HubSpot tools
   like logs and other material. It must be unique to this account."*)
3. Under **Scopes → Selected scopes**, click **+ Add new scope** and add these
   two, and nothing else:

   | Scope | Why |
   |---|---|
   | `crm.objects.contacts.read` | Find the contact by `mn_member_id`, find pending replies |
   | `crm.objects.contacts.write` | Create notes, stamp the last-inbound date, clear the reply property |

   Each chosen scope appears in the list with a **Delete** link. Expand
   **Summary of selected scopes** if you want to double-check.
4. Click the create button at the top right (wording may differ).

**2c. Copy the key.** The key's page shows a **Service Key** box (*"Used to make
API calls."*) with the key masked, starting `pat-`. Click **Show**, then
**Copy**. The same page has **Rotate**, **View Logs**, **Edit** and **Delete this
Service Key**.

> ⚠️ **Use a new key, not one another integration already uses.** Rotating a
> shared key for one integration silently breaks the other with `HubSpot 401`.

**2d. Store it in Script Properties.**
1. In the Apps Script editor, click **Project Settings** (gear).
2. Scroll down to **Script Properties**.
3. Click **Add script property** (if properties already exist, click **Edit
   script properties** first, then **Add script property**).
4. **Property:** `DM_HS_TOKEN`. **Value:** paste the key. No quotes, no spaces.
5. Click **Save script properties**.

> ⚠️ **Nothing is stored until you click "Save script properties".** Values typed
> into the boxes and left unsaved are simply gone. In a real setup, credentials
> that were typed in but never saved showed up as length **0**, and Mighty then
> rejected the sign-in with `invalid_client` ... *"no client authentication
> included"*. `dmCheckCreds` (next) catches this.

**2e. Authorize the script with Google.** This is a one-time prompt, and it's
best done now: in Step 4 you'll have only a few minutes to use a Mighty code, and
this prompt takes time the first time.
1. Click **Editor** (`<>`) in the left rail and open **Auth.gs**.
2. Pick **`dmCheckCreds`** in the function dropdown and click **Run**.
3. An **Authorization required** dialog appears. Click **Review permissions**.
4. Choose the Google account that owns the project.
5. Google warns **"Google hasn't verified this app"**. That's normal for a script
   you wrote yourself. Click **Advanced**, then **Go to Mighty DM Sync
   (unsafe)**.
6. Review the access list and click **Allow**. If there are checkboxes, check all
   of them (**Select all**). The script needs to reach external services
   (Mighty and HubSpot), edit your spreadsheets, and run when you're not present
   (the triggers). Wording may differ.
7. The function then runs.

✅ **Check:** the Execution log shows `DM_HS_TOKEN set: true`. The other lines
show lengths of 0 and `DM_REFRESH_TOKEN set: false` for now; that's expected.

> ⚠️ If the log shows the Google error *"An unknown error has occurred, please
> try again later."*, click **Run** again. In testing it was transient and the
> retry worked. If it keeps happening, the project's Script Properties store may
> be full (it's capped at 500 KB). This project stores very little there, so
> that only happens if you've reused an old project.

### Step 3: Create the Mighty OAuth application

*About 10 minutes.*

**3a. Open OAuth Applications.** Sign in to your Network as a Host and open
**Admin**. In the left menu, expand **Integrations** and click **OAuth
Applications**. Click **New OAuth Application** (green button, top right).

**3b. Fill in the "New OAuth Application" dialog.** Scroll inside the dialog to
reach everything.

| Field | What to enter |
|---|---|
| **Application Name** \* | `Mighty DM Sync`. Members may see this name on a consent screen. |
| **Redirect URI** \* | Exactly your `DM_REDIRECT_URI` from 1e, e.g. `https://your-community.mn.co/`. (Hint: *"Multiple URIs can be separated by newlines"*.) |
| **Host Scopes** | Check **`host:read:network_members`** (*"View members in the network"*). Leave the other four unchecked. |
| **Member Scopes** | Check **`read:userinfo`** (*"View your basic profile information"*) and **`read:network`** (*"View all network content you have access to (excluding chats)"*). If the list includes `read:chats` and `write:chats`, check both. Leave `write:posts` and `write:comments` unchecked. |
| **Confidential client** | **Checked.** Apps Script runs on Google's servers and keeps the secret in Script Properties. The code sends the secret and doesn't use PKCE, so a Public client won't work. |
| **Skip consent screen** | **Unchecked** (recommended). You then see a consent screen once in Step 4. If you check it, Mighty sends you straight back without one. |

Click **Create**.

> ⚠️ **No chat scopes in the list is not necessarily a blocker.** `read:network`
> says *"excluding chats"*, and some Networks' dialogs offer no chat scope at
> all, yet reading and replying to DMs has been seen working with such an app.
> Step 6 proves whether DM reads work for you before anything depends on them.

**3c. Copy the credentials.** The application now appears as a card. It shows
**Client ID** (with a copy icon), **Client Secret** (masked, with **Reveal** and a
copy icon), **Redirect URI**, **Type: Confidential**, **Scopes** and **Consent
screen**. Use the copy icons; the fields display only part of each value.

**3d. Add three Script Properties.** In Apps Script: **Project Settings → Script
Properties → Edit script properties**, then **Add script property** for each:

| Property | Value |
|---|---|
| `DM_CLIENT_ID` | The Client ID |
| `DM_CLIENT_SECRET` | The Client Secret (click **Reveal**, then copy) |
| `DM_SCOPES` | The scopes you checked in 3b, separated by single spaces, e.g. `host:read:network_members read:userinfo read:network` |

Click **Save script properties**.

> ⚠️ **`DM_SCOPES` must not ask for more than the application has.** A scope that
> isn't on the application fails the sign-in with `invalid_scope`. Asking for
> fewer is fine.

> **Don't add any other `DM_` properties by hand.** The script writes
> `DM_OAUTH_STATE`, `DM_REFRESH_TOKEN`, `DM_AUTH_BASIC`,
> `DM_ID_MAPPING_CONFIRMED`, `DM_BASELINE_AT`, `DM_BASELINE_CURSOR`,
> `DM_BASELINE_DONE` and `DM_INBOX_INCOMPLETE` itself as setup goes on.

**3e. Check the credentials.** Open **Auth.gs**, run **`dmCheckCreds`**.

✅ **Check:** the log shows:

```
DM_CLIENT_ID length: 43 (expect 43)
DM_CLIENT_SECRET length: 43 (expect 43)
DM_REFRESH_TOKEN set: false
DM_HS_TOKEN set: true
OAuth host: https://your-community.mn.co | redirect: https://your-community.mn.co/
```

A length of **0** means the property wasn't saved (repeat 3d and click **Save
script properties**). Any length other than 43 means it was copied partly;
recopy it with the copy icon.

### Step 4: Sign in as the sending account

*About 10 minutes. Once you open the sign-in link, finish 4c to 4f within a few
minutes: Mighty's codes are single-use and expire quickly.*

**4a. Open a private window** (Chrome: **Ctrl+Shift+N**) and sign in to your
Mighty Network **as the sending account** from "Before you start". Keep the Apps
Script editor open in your normal window.

**4b. Get the sign-in link.** In the editor, open **Auth.gs**, run
**`dmLogAuthorizeUrl`**. The log shows:

```
Open this signed in as the HOST account DMs should come from, approve, then copy the code= and state= values from the address bar:
https://your-community.mn.co/oauth/authorize?response_type=code&client_id=...&redirect_uri=https%3A%2F%2Fyour-community.mn.co%2F&scope=...&state=...
```

Select the whole `https://...` line in the log and copy it.

> ⚠️ **Only the newest link works.** Each run of `dmLogAuthorizeUrl` makes a new
> `state` value and forgets the old one. If you run it twice, use the second
> link, or `dmExchangeCode` later refuses the code with *"state does not match
> the sign-in URL this project generated"*.

**4c. Approve.** Paste the link into the **private window's** address bar and
press **Enter**. If a consent screen appears, it names **Mighty DM Sync** and the
permissions it asks for. Approve it (the button wording may differ).

**4d. Copy the code and state.** Mighty sends you to your redirect page, and the
address bar reads:

```
https://your-community.mn.co/?code=AbC123...&state=9f8e7d...
```

The page itself is just your community; the values are only in the address bar.
Copy two values:

- **code**: everything after `code=` up to (not including) the next `&`.
- **state**: everything after `state=` up to the end (or the next `&`).

> ⚠️ Mighty requires `state`. A hand-built link without it lands on an error
> page whose address ends in `error=invalid_request&error_description=Missing+required+parameter%3A+state.`
> Always use the link from `dmLogAuthorizeUrl`, which includes it.

**4e. Exchange the code.** The function dropdown can't pass values to a
function, so you add a tiny temporary one:
1. Open **Setup.gs** and scroll to the very bottom.
2. Paste this on a new line, replacing the two placeholders (keep the quotes):

   ```javascript
   function once() { dmExchangeCode("PASTE_CODE", "PASTE_STATE"); }
   ```

3. Press **Ctrl+S**.
4. Pick **`once`** in the dropdown and click **Run**.

✅ **Check:** the log shows:

```
Stored. Granted scopes: host:read:network_members read:userinfo read:network
Next: run dmWhoAmI().
```

It may first show `Body credentials rejected; retrying with HTTP Basic...`.
That's fine: the script remembers which method worked.

| Error in the log | Cause | Fix |
|---|---|---|
| `state does not match the sign-in URL this project generated` | Link from an older `dmLogAuthorizeUrl` run, or state copied wrong | Start again at 4b |
| `Token exchange failed: HTTP 400 ... invalid_grant` | Code already used, expired, or the redirect URI differs | Start again at 4b and move faster. Recheck `DM_REDIRECT_URI` against the app. |
| `Token exchange failed: HTTP 401 ... invalid_client` | Wrong or partly copied id or secret | Run `dmCheckCreds`; recopy (3c, 3d) |
| `Mighty returned no refresh_token` | The application isn't returning refresh tokens | Check the app is **Confidential**; ask Mighty support |

**4f. Delete the temporary function.** Remove the `function once() ...` line
from **Setup.gs** and press **Ctrl+S**. It holds a spent code, and the refresh
token is already safe in Script Properties.

**4g. Confirm the account.** In **Setup.gs**, run **`dmWhoAmI`**.

✅ **Check:** the log reads:

```
Token acts as: Community Team (member id 12345, GlobalID TWVtYmVyOjEyMzQ1).
Every synced DM is this account's inbox, and every reply is sent as this account.
```

If it names the wrong person: **Project Settings → Script Properties → Edit
script properties**, delete the `DM_REFRESH_TOKEN` row (trash icon), click
**Save script properties**, and repeat this step with the private window signed
in as the right account.

### Step 5: Create the two HubSpot contact properties

*About 15 minutes.*

**5a. Open contact properties.** In HubSpot, click the **Settings** gear. In the
left menu, go to **Data Management → Properties** (wording may differ). Make sure
the object selector reads **Contact properties**, then click **Create
property**.

**5b. Create both properties.** HubSpot shows either a **Create new property**
side panel (with a **Create manually** tab) or an **Add property details** page.
Either way, create each row of this table:

| Property label | Internal name | Field type |
|---|---|---|
| `Mighty DM reply` | `mn_dm_reply` | **Multi-line text** |
| `Mighty DM last inbound at` | `mn_dm_last_inbound_at` | **Date and time picker** (wording may differ) |

For each one:
1. Type the **Property label**.
2. **Set the internal name by hand.** HubSpot builds it from the label, and
   `Mighty DM reply` becomes `mighty_dm_reply`, which is wrong. In the side
   panel, click the **`</>`** icon next to the label field to edit it. On the
   older page it's shown as **Internal name** under the label.
3. If there's a **Group** field, pick **Contact information**, or create a group
   called `Mighty` (wording may differ).
4. Choose the **Field type** from the dropdown (**Single-line text**,
   **Multi-line text**, **URL**, **Email**, ...).
5. Leave **Require unique values for this property** unchecked.
6. Create the property.

> ⚠️ **The internal name is what the code uses, and it can't be changed later.**
> If it's off by one character, HubSpot's search simply returns nothing: replies
> sit in the property unsent with no error anywhere. If you get it wrong, delete
> the property and create it again, or change `HS_REPLY_PROP` /
> `HS_LAST_INBOUND_PROP` in [`Config.gs`](Config.gs) to match what you created.

**5c. Check `mn_member_id` exists.** In the same list, search for
`mn_member_id`. It must be there (a **number** property), and your members'
contacts must have it filled in. This guide doesn't create it: a roster sync or
a Mighty webhook usually fills it.

**5d. Make the reply box easy to find.** On any contact record, the left
sidebar's **About this contact** card only shows some properties. Add **Mighty DM
reply** and **Mighty DM last inbound at** to it through the card's customize or
edit option (wording may differ). Until you do, reps can reach them through
**View all properties** and the search box there.

**5e. Create a "Mighty DMs" contact view.**
1. Go to **CRM → Contacts**.
2. Add a new view: click **+** next to the view tabs, or **All views → Create new
   view** (wording may differ). Name it `Mighty DMs: last 7 days`.
3. Open **Advanced filters** and add a filter: **Mighty DM last inbound at** is in
   the **last 7 days** (wording may differ).
4. Use **Edit columns** to add **Mighty DM last inbound at** and **Mighty DM
   reply**, then click the **Mighty DM last inbound at** column header to sort
   newest first.
5. Save the view.

✅ **Check:** both new properties appear in **Contact properties** with internal
names **exactly** `mn_dm_reply` and `mn_dm_last_inbound_at`, and the view exists
(it's empty until Step 9).

### Step 6: Prove DM reads work

*About 2 minutes.*

In **Setup.gs**, run **`dmPeekInbox`**. It reads three DMs and their newest
messages, and writes nothing anywhere.

✅ **Check:** the log looks like this:

```
Inbox of Community Team: 25 conversation(s) on page 1, more pages: true
- Alex Rivera | last message 2026-09-01T18:07:12Z | group: false | 25 message(s) readable
    2026-09-01T18:07:12Z  Alex Rivera: Thanks, see you Thursday!
    2026-09-01T17:55:40Z  Community Team: Hi Alex, ...
- ...
```

Each conversation says *"N message(s) readable"*, and you can see real text.

> ⚠️ **If this errors, stop here.** Mighty has returned
> `INTERNAL_SERVER_ERROR` when listing *space* chat messages. This step confirms
> *DM* message lists work for your account. A `FORBIDDEN` error means the token
> can't read chats: ask Mighty support which scope enables chat for your
> Network, add it to the app and `DM_SCOPES`, and redo Step 4.

### Step 7: Confirm member ids match

*About 10 minutes.*

**7a. Run the check.** In **Setup.gs**, run **`dmVerifyIdMapping`**. For up to
10 one-to-one DMs it logs:

```
Alex Rivera
   DM participant: User/12345678, resourceId 12345678
   member(id: 12345678) is the same person: YES
   HubSpot contact with mn_member_id = 12345678: https://app.hubspot.com/contacts/12345678/record/0-1/987654321
...
Checked 10 DM(s): id round-trips for 10, HubSpot contact found for 9.
Open each HubSpot link and confirm it is the same person as the Mighty name above.
If every one matches, run dmConfirmIdMapping(). If any is wrong, stop: don't confirm.
```

**7b. Open every HubSpot link** (copy it from the log into a browser tab) and
confirm the contact is the same person as the Mighty name above it.

- **same person: NO** on any row, or a HubSpot link that opens someone else:
  **stop.** Notes would land on the wrong contacts and replies would go to the
  wrong members. Fix the `mn_member_id` values first.
- **`none`** for a row: that member has no contact with their `mn_member_id`.
  Fine for a few; their DMs will go to the **DM Unmatched** tab. If *every* row
  says `none`, `mn_member_id` isn't filled in, or `HS_MEMBER_ID_PROP` in
  [`Config.gs`](Config.gs) doesn't match its internal name.
- `WARNING: 2+ contacts share mn_member_id ...`: duplicate contacts. Merge them in
  HubSpot.

**7c. Confirm.** When every link matches, run **`dmConfirmIdMapping`** (also in
**Setup.gs**).

✅ **Check:** the log reads `Confirmed. HubSpot writes are unlocked. Next: dmBaselineInbox().`

Until you confirm, `dmPollInbox` and `dmPollOutbox` refuse to run and log
`Blocked: run dmVerifyIdMapping() ...`.

### Step 8: Record where the inbox stands

*About 5 minutes, longer for a big inbox.*

In **Setup.gs**, run **`dmBaselineInbox`**. It records the newest message time of
every existing conversation, so only DMs that arrive **after** this point are
copied. Years of old welcome messages don't land in HubSpot.

A big inbox takes several runs (each run stops itself after about 4 minutes).
If the log says:

```
Recorded 250 more conversation(s) (250 total). NOT done: run dmBaselineInbox() again.
```

click **Run** again, until it says:

```
Baseline done: 612 conversation(s). Only DMs after 2026-09-29 14:05 ET will be copied. Next: test (README step 8), then dmInstallTriggers().
```

(The "step 8" in that message means the test in Step 9 below.)

✅ **Check:** the log says **Baseline done**. In the sheet, the hidden
`_dm_state` tab now exists: click the **All sheets** list button at the bottom
left of the sheet to see it. Don't edit it.

### Step 9: Test end to end

*About 15 minutes.*

Use your ordinary test member account. It needs a HubSpot contact with its
`mn_member_id` filled in.

**9a. Inbound (Mighty to HubSpot).**
1. In a private window, sign in to Mighty as the **test** account and send the
   sending account a DM: `inbound test`.
2. In Apps Script, open **Inbox.gs** and run **`dmPollInbox`**.

   ```
   Inbox: 1 conversation(s) with new messages, 1 note(s) added, 0 message(s) to 'DM Unmatched', 1 page(s) read.
   ```

3. In HubSpot, open the test contact.

✅ **Check (9a):** the contact's activity timeline has a note headed **Mighty DM
from [test member's name]** with the time and the text `inbound test`, and
**Mighty DM last inbound at** is set. The sheet's **DM Log** tab has a row with
direction `inbound` and status `noted`, and the contact appears in your
**Mighty DMs: last 7 days** view.

If the log says `0 note(s) added, 1 message(s) to 'DM Unmatched'`, the test
contact's `mn_member_id` is missing or different. The message text is in the
**DM Unmatched** tab.

**9b. Outbound (HubSpot to Mighty).**
1. On the test contact in HubSpot, find **Mighty DM reply** (sidebar, or **View
   all properties** and search). Type `outbound test` and save the field (click
   outside it, or click **Save** if HubSpot shows one).
2. Wait about 30 seconds: HubSpot's search takes a moment to see new values.
3. In Apps Script, open **Outbox.gs** and run **`dmPollOutbox`**.

   ```
   Outbox: 1 sent, 0 skipped, 0 failed/unknown.
   ```

   If the log shows only *Execution started* and *Execution completed*, the
   script found no pending reply yet. Wait a minute and run it again.

✅ **Check (9b):** the test account's Mighty inbox has `outbound test` from the
sending account, in the same conversation as 9a. The contact has a note **Mighty
DM sent by [sending account] via HubSpot**, **Mighty DM reply** is empty again,
and **DM Log** has a row with direction `outbound (HubSpot)` and status `sent`.

If the note says **Mighty DM NOT sent (...)**, the reason follows it. See the
table under "Using it".

**9c. No echo.** Open **Inbox.gs** again and run **`dmPollInbox`**.

✅ **Check (9c):** no second note for `outbound test` appears on the contact.
The inbox sync recognizes replies it sent itself.

**9d. Reply in the Mighty app (optional).** As the sending account, type a reply
to the test account in the Mighty app, then run `dmPollInbox`. The contact gets
a note headed **Mighty DM sent by [sending account] (in the Mighty app)**, so the
timeline shows both sides.

### Step 10: Turn it on

*About 20 minutes, most of it waiting.*

**10a. Install the triggers.** In **Setup.gs**, run **`dmInstallTriggers`**.

✅ The log reads `Installed: dmPollInbox every 15 min, dmPollOutbox every 5 min.`
(It removes its own old triggers first, so running it twice doesn't duplicate
them.)

**10b. See them on the Triggers page.** Click **Triggers** (alarm-clock icon) in
the left rail. The page reads *"Showing 2 triggers"*, with columns **Owned by**,
**Last run**, **Deployment**, **Event**, **Function** and **Error rate**:

| Owned by | Deployment | Event | Function |
|---|---|---|---|
| Me | Head | Time-based | `dmPollInbox` |
| Me | Head | Time-based | `dmPollOutbox` |

Don't add triggers with **+ Add Trigger** on this page. `dmInstallTriggers`
manages exactly these two.

**10c. Watch the first runs.** After 5 to 15 minutes, click **Executions** (the
list icon with a ▶) in the left rail. Each trigger run appears as a row with its
function name, a type of time-driven, and a status (wording may differ). Click a
row to see its log lines. Expect `dmPollOutbox` about every 5 minutes and
`dmPollInbox` about every 15.

**10d. Check the status.** In **Setup.gs**, run **`dmStatus`**.

✅ **Check:** the log includes:

```
DM_REFRESH_TOKEN set: true
DM_HS_TOKEN set: true
ID mapping confirmed: true
Baseline done: true
Triggers: dmPollInbox, dmPollOutbox
```

(The order of the two trigger names may differ.)

**10e. Failure emails.** Google emails the project owner when a trigger fails
(daily by default). To change that, click the pencil on a trigger's row on the
**Triggers** page and adjust the failure notification setting (wording may
differ). Keep it on: an expired Mighty sign-in shows up there first, as
`Mighty token refresh failed ... invalid_grant`.

**To pause the sync,** run **`dmRemoveTriggers`** in **Setup.gs**. The log reads
`Removed 2 DM trigger(s). State and logs are untouched.` Run
`dmInstallTriggers` to resume; nothing is lost or re-sent.

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
