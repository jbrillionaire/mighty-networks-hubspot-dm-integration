<!--
  API-NOTES.md -- what the Mighty API actually does for direct messages
  Author:  Jibril Sulaiman
  Created: 2026-09-28
  What:    The exact operations, scopes and behaviors this repo relies on,
           read from the live SDL on 2026-09-28 and validated with graphql-js.
  Why:     The docs summarize chat in one paragraph. The schema descriptions
           hold the details that decide whether a message is really sent.
-->

# Mighty API notes: direct messages

Verified against the published SDL on **2026-09-28**. Every query and mutation
in [`src/direct-messages.js`](../src/direct-messages.js) validated with no
errors against that schema. Re-check any time with `npm run check-schema`.

## Endpoints

| What | URL |
|---|---|
| GraphQL (POST) | `https://api.mn.co/networks/<subdomain-or-id>/graphql` |
| Public SDL (GET, no auth) | `https://api.mn.co/networks/<subdomain-or-id>/graphql/schema` |
| Authorize | `https://<subdomain>.mn.co/oauth/authorize` |
| Token / refresh | `https://<subdomain>.mn.co/oauth/token` |
| Revoke | `https://<subdomain>.mn.co/oauth/revoke` |
| Discovery (RFC 8414) | `https://<subdomain>.mn.co/.well-known/oauth-authorization-server` |
| Host GraphiQL | `https://<subdomain>.mn.co/admin/headless-api/explorer` |

OAuth lives on the **community host**, GraphQL on **api.mn.co**. A custom domain
works for members browsing, but use the `mn.co` subdomain in configuration.

## Operations used

| Operation | Purpose | Required scope |
|---|---|---|
| `me` | Who the token sends as | (any valid token) |
| `network.memberByEmail(email:)` | Email to member | `host:read:network` or `host:read:network_members` (or `host:write:network_members`) |
| `network.member(id:)` | Numeric resource ID or GlobalID to member | `read:network`, `host:read:network`, `host:read:network_members` or `host:write:network_members` |
| `createConversation(input:)` | Start a DM, or post into the existing one with the same people | `write:chats` |
| `createDirectMessage(input:)` | Post into a known conversation or reply thread | `write:chats` |
| `me.directMessages(first:, after:)` | The sender's own DM list | `read:chats` or `write:chats` |

`write:chats` includes everything `read:chats` grants.

### `CreateConversationInput`

| Field | Notes |
|---|---|
| `recipientIds: [ID!]!` | **GlobalIDs**, excluding yourself. More than one makes a group chat. |
| `text: String!` | HTML is sanitized server-side. |
| `preserveParagraphSpacing` | `true` turns bare newlines into line breaks. This repo sends `true`. |
| `reportSkipsAsOutcomes` | `true` returns a coded `outcome` instead of raising. This repo always sends `true`. |
| `title` | Only for a new group conversation. |
| `assetIds`, `embeddedLinkId` | Attachments and link previews (not used yet). |

### `DirectMessageOutcome`

`SENT` is the only value that means a message was delivered. Everything else
means nothing was sent:

| Outcome | Meaning |
|---|---|
| `SKIPPED_CONVERSATION_UNAVAILABLE` | Conversation or recipient is gone |
| `SKIPPED_NETWORK_CHAT_DISABLED` | Private chat is off for the whole Network |
| `SKIPPED_RECIPIENT_CHAT_DISABLED` | The member turned private chat off |
| `SKIPPED_RECIPIENT_LIMITED_MEMBER` | Limited Members can't receive private chat |
| `SKIPPED_SELF_MESSAGE` | Recipient is the sender |
| `SKIPPED_SENDER_CHAT_DISABLED` | The sending account has private chat off |
| `SKIPPED_SENDER_NOT_HOST` | **The sending account is not a Network Host** |

The payload also carries `errors: [String!]!`, separate from top-level GraphQL
errors. Both are checked.

## Behaviors that decide the design

1. **A token only reaches its own user's conversations.** There is no admin
   mode that sends as the brand or reads other members' inboxes. Outreach comes
   from whichever account authorized the token, so make that a Host account
   with a recognizable name and avatar.
2. **Chat scopes always show the consent screen**, even on applications set to
   skip it. The first token needs a person to click Approve; after that,
   refresh tokens keep scripts running.
3. **Host scopes restrict sign-in to Hosts.** Requesting any `host:*` scope
   means members and moderators can't finish the OAuth flow at all.
4. **Access tokens last about an hour; refresh tokens may rotate.** Always save
   the refresh token returned by a refresh. `invalid_grant` means re-authorize.
5. **Errors come back with HTTP 200.** Check `errors` on every response.
6. **A User-Agent header is required.** Without one, `api.mn.co` returns an HTML
   bot challenge with HTTP 403.
7. **`memberByEmail` fails quietly.** It returns `null` for a missing member
   *and* for a refused lookup (wrong role, plan without member-email
   visibility, or the member didn't consent to share their email). Failed
   lookups are rate limited per Network and raise `THROTTLED` past the limit.
   Numeric member IDs from webhooks or the Admin REST API avoid this.
8. **OAuth applications need the Scale plan or above** (Network Admin >
   Integrations > OAuth Applications).
9. **Query cost limit is 1,500.** Connections page at most 50 at the top level
   and 25 when nested.

## Deprecations to watch

- `PrivateMessage.user` is deprecated in favor of `member`, removal date
  **2026-12-15**. This repo doesn't use it.

## No-code alternative

Mighty's own **automation rules** include a `SEND_DIRECT_MESSAGE` action. If a
trigger inside Mighty is enough (a member joins, buys a plan, gets a tag), an
automation may be simpler than this repo. Use the API when the audience or
timing is decided outside Mighty: a CRM segment, a spreadsheet, a webhook from
another system.
