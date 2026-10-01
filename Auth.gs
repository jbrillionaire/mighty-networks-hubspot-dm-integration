/**
 * Auth.gs -- Mighty OAuth for the DM sync (its own app, its own token)
 * --------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28 (ET)
 *
 * Deploy:  "Mighty DM Sync" Apps Script project only.
 *
 * What it does:
 *   One-time sign-in (dmLogAuthorizeUrl -> dmExchangeCode), then mints a
 *   short-lived access token from the stored refresh token on every run,
 *   saving the new refresh token whenever Mighty rotates it.
 *
 * Why it exists:
 *   The DM token IS the inbox being synced and the account replies are sent
 *   from. Sign in as the Host account members should hear from. A token only
 *   ever sees its own user's DMs, so a second inbox means a second project.
 *
 * Lessons from running Mighty OAuth in production:
 *   - Mighty REQUIRES `state` on /oauth/authorize.
 *   - /oauth/token rejected client credentials in the body once with
 *     invalid_client; retry with HTTP Basic and remember which worked.
 *   - Refresh tokens rotate. If the new one isn't saved, tomorrow's run fails.
 *
 * Script Properties used (all prefixed DM_ so nothing collides):
 *   DM_CLIENT_ID, DM_CLIENT_SECRET, DM_SCOPES, DM_REFRESH_TOKEN,
 *   DM_OAUTH_STATE, DM_AUTH_BASIC
 */

function dmProps_() { return PropertiesService.getScriptProperties(); }

// ---------- step A: print the sign-in URL ----------
function dmLogAuthorizeUrl() {
  const p = dmProps_();
  if (!p.getProperty("DM_CLIENT_ID")) throw new Error("Add DM_CLIENT_ID in Project Settings > Script Properties first.");
  const state = Utilities.getUuid().replace(/-/g, "");
  p.setProperty("DM_OAUTH_STATE", state);

  const url = DM_OAUTH_HOST + "/oauth/authorize"
    + "?response_type=code"
    + "&client_id=" + encodeURIComponent(p.getProperty("DM_CLIENT_ID"))
    + "&redirect_uri=" + encodeURIComponent(DM_REDIRECT_URI)
    + "&scope=" + encodeURIComponent(p.getProperty("DM_SCOPES") || "host:read:network_members read:userinfo read:network")
    + "&state=" + encodeURIComponent(state);
  Logger.log("Open this signed in as the HOST account DMs should come from, approve, then copy the code= and state= values from the address bar:\n" + url);
}

// ---------- step B: swap the code for a refresh token ----------
// Paste both values from the redirect URL: dmExchangeCode("code...", "state...")
function dmExchangeCode(code, state) {
  const p = dmProps_();
  if (!code) throw new Error("Pass the code= value from the redirect URL.");
  // CSRF check: only exchange a code for the request we started.
  if (state !== p.getProperty("DM_OAUTH_STATE")) {
    throw new Error("state does not match the sign-in URL this project generated. Run dmLogAuthorizeUrl() again and use that URL.");
  }
  const fields = { grant_type: "authorization_code", code: code, redirect_uri: DM_REDIRECT_URI };

  let res = dmPostToken_(fields, false);
  if (res.getResponseCode() === 401) {
    Logger.log("Body credentials rejected; retrying with HTTP Basic...");
    res = dmPostToken_(fields, true);
    if (res.getResponseCode() < 300) p.setProperty("DM_AUTH_BASIC", "1");
  }
  if (res.getResponseCode() >= 300) {
    throw new Error("Token exchange failed: HTTP " + res.getResponseCode() + " " + res.getContentText()
      + "\ninvalid_client = wrong/truncated id or secret. invalid_grant = code reused or expired; start again at dmLogAuthorizeUrl().");
  }
  const tok = JSON.parse(res.getContentText());
  if (!tok.refresh_token) throw new Error("Mighty returned no refresh_token, so the sync can't run unattended. Body: " + res.getContentText());
  p.setProperty("DM_REFRESH_TOKEN", tok.refresh_token);
  p.deleteProperty("DM_OAUTH_STATE");
  CacheService.getScriptCache().remove("dm_access_token");
  Logger.log("Stored. Granted scopes: " + (tok.scope || "(not reported)") + "\nNext: run dmWhoAmI().");
}

function dmPostToken_(fields, useBasic) {
  const p = dmProps_();
  const id = p.getProperty("DM_CLIENT_ID"), secret = p.getProperty("DM_CLIENT_SECRET");
  if (!id || !secret) throw new Error("DM_CLIENT_ID / DM_CLIENT_SECRET missing from Script Properties.");
  const payload = {};
  Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
  const opts = { method: "post", payload: payload, muteHttpExceptions: true, headers: { "User-Agent": DM_USER_AGENT } };
  if (useBasic) opts.headers.Authorization = "Basic " + Utilities.base64Encode(id + ":" + secret);
  else { payload.client_id = id; payload.client_secret = secret; }
  return UrlFetchApp.fetch(DM_OAUTH_HOST + "/oauth/token", opts);
}

// ---------- every run: a fresh access token ----------
function dmAccessToken_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const hit = cache.get("dm_access_token");
    if (hit) return hit;
  }
  const p = dmProps_();
  const refresh = p.getProperty("DM_REFRESH_TOKEN");
  if (!refresh) throw new Error("No DM_REFRESH_TOKEN. Do README step 4 (dmLogAuthorizeUrl + dmExchangeCode).");

  const basic = p.getProperty("DM_AUTH_BASIC") === "1";
  const fields = { grant_type: "refresh_token", refresh_token: refresh };
  let res = dmPostToken_(fields, basic);
  if (res.getResponseCode() === 401) res = dmPostToken_(fields, !basic);
  if (res.getResponseCode() >= 300) {
    throw new Error("Mighty token refresh failed: HTTP " + res.getResponseCode() + " " + res.getContentText()
      + "\nIf this says invalid_grant, the refresh token was revoked or expired: redo README step 4.");
  }
  const tok = JSON.parse(res.getContentText());
  if (tok.refresh_token && tok.refresh_token !== refresh) p.setProperty("DM_REFRESH_TOKEN", tok.refresh_token); // rotation
  const ttl = Math.max(60, Math.min(3300, (tok.expires_in || 3600) - 300));
  cache.put("dm_access_token", tok.access_token, ttl);
  return tok.access_token;
}

// Lengths only, never values. Mighty client ids and secrets are 43 characters.
function dmCheckCreds() {
  const p = dmProps_();
  Logger.log("DM_CLIENT_ID length: " + (p.getProperty("DM_CLIENT_ID") || "").length + " (expect 43)");
  Logger.log("DM_CLIENT_SECRET length: " + (p.getProperty("DM_CLIENT_SECRET") || "").length + " (expect 43)");
  Logger.log("DM_REFRESH_TOKEN set: " + !!p.getProperty("DM_REFRESH_TOKEN"));
  Logger.log("DM_HS_TOKEN set: " + !!p.getProperty("DM_HS_TOKEN"));
  Logger.log("OAuth host: " + DM_OAUTH_HOST + " | redirect: " + DM_REDIRECT_URI);
}
