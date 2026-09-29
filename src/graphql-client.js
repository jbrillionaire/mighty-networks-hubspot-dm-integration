/**
 * graphql-client.js -- minimal client for the Mighty Networks GraphQL API
 * -----------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Server side or local only (it holds OAuth tokens).
 *
 * What it does:
 *   POSTs a query to https://api.mn.co/networks/<network>/graphql with a
 *   Bearer token and a User-Agent, refreshes the token when it is about to
 *   expire (or once after an UNAUTHENTICATED error), and turns GraphQL errors
 *   into thrown MightyApiError objects.
 *
 * Why it exists:
 *   Three Mighty behaviors turn into silent failures without it:
 *   1. No User-Agent  -> bot protection answers 403 with an HTML page, which
 *      surfaces as a confusing JSON parse error.
 *   2. Errors arrive with HTTP 200 in an `errors` array. Checking only the
 *      status code treats a failed send as a success.
 *   3. Mutations return a payload `errors: [String!]!` list separately from
 *      GraphQL errors. That list is checked by callers in direct-messages.js.
 */

import { isExpiring, loadTokens, refreshTokens, saveTokens } from './oauth.js';

export class MightyApiError extends Error {
  constructor(message, { code, status, errors } = {}) {
    super(message);
    this.name = 'MightyApiError';
    this.code = code;      // extensions.code, e.g. FORBIDDEN, NOT_FOUND, THROTTLED
    this.status = status;  // HTTP status
    this.errors = errors;  // raw GraphQL errors array
  }
}

export function createClient(config, { fetchImpl = fetch, tokenStore } = {}) {
  const store = tokenStore ?? {
    load: () => loadTokens(config.tokenFile),
    save: (t) => saveTokens(config.tokenFile, t),
  };

  async function currentToken(forceRefresh = false) {
    let tokens = store.load();
    if (!tokens) throw new MightyApiError('No tokens found. Run: npm run authorize', { code: 'UNAUTHENTICATED' });
    if (forceRefresh || isExpiring(tokens)) {
      tokens = await refreshTokens(config, tokens, fetchImpl);
      store.save(tokens); // refresh tokens can rotate: persist every time
    }
    return tokens.access_token;
  }

  async function post(query, variables, token) {
    const res = await fetchImpl(config.graphqlUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': config.userAgent,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const hint = res.status === 403 ? ' (403 with non-JSON body: usually a missing User-Agent or blocked client)' : '';
      throw new MightyApiError(`Mighty API returned non-JSON, HTTP ${res.status}${hint}`, { status: res.status, code: res.status === 401 ? 'UNAUTHENTICATED' : undefined });
    }
    return { status: res.status, json };
  }

  return async function request(query, variables = {}) {
    let { status, json } = await post(query, variables, await currentToken());
    const unauth = status === 401 || json.errors?.some((e) => e.extensions?.code === 'UNAUTHENTICATED');
    if (unauth) ({ status, json } = await post(query, variables, await currentToken(true)));

    if (json.errors?.length) {
      const first = json.errors[0];
      throw new MightyApiError(json.errors.map((e) => e.message).join('; '), {
        code: first.extensions?.code, status, errors: json.errors,
      });
    }
    return json.data;
  };
}
