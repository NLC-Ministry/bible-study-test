// ============================================================
// auth.js - Logto OIDC & NLC Member Hub Integration Client
// ============================================================

import {
  AUTH_POLICY_VERSION,
  createAuthContinuation,
  cleanReturnTo,
  parseContinuationFromSearchParams,
  parseAuthContinuation,
  serializeAuthContinuation
} from "./auth-continuation.mjs";
import {
  detectAuthenticationEnvironment,
  shouldGateInteractiveAuth
} from "./auth-environment.js";

const auth = {
  config: {
    issuer: (typeof NLC_CONFIG !== "undefined" && NLC_CONFIG.issuer) || "https://sso.newlife.org.tw/oidc",
    clientId: (typeof NLC_CONFIG !== "undefined" && NLC_CONFIG.clientId) || "",
    memberHubUrl: (typeof NLC_CONFIG !== "undefined" && NLC_CONFIG.memberHubUrl) || "https://member.newlife.org.tw",
    scopes: (typeof NLC_CONFIG !== "undefined" && NLC_CONFIG.scopes) || "openid profile email offline_access member:read.basic",
    platformResource: (typeof NLC_CONFIG !== "undefined" && NLC_CONFIG.platformResource) || "https://platform.newlife.org.tw"
  },

  keys: {
    accessToken: "nlc_access_token",
    idToken: "nlc_id_token",
    refreshToken: "nlc_refresh_token",
    expiresAt: "nlc_token_expires_at",
    state: "nlc_auth_state",
    verifier: "nlc_auth_verifier",
    nonce: "nlc_auth_nonce",
    flowId: "nlc_auth_flow_id",
    continuation: "nlc_auth_continuation",
    continuationVersion: "nlc_auth_continuation_version",
    memberContext: "nlc_member_context",
    supabaseAccessToken: "nlc_supabase_access_token",
    supabaseExpiresAt: "nlc_supabase_expires_at",
    supabaseProfile: "nlc_supabase_profile",
    repairRequired: "nlc_login_repair_required"
  },

  metadata: null,

  _joinUrl(base, path) {
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  },

  getMemberHubUrl(path = "") {
    const base = (this.config.memberHubUrl || "https://member.newlife.org.tw").replace(/\/+$/, "");
    if (!path) return base;
    return this._joinUrl(base, path);
  },

  openMemberHub(path = "") {
    const url = this.getMemberHubUrl(path);
    window.open(url, "_blank", "noopener,noreferrer");
  },

  isMemberHubSession() {
    return this.isLoggedIn();
  },

  _metadataCacheKey: "nlc_oidc_metadata",
  _metadataFreshMs: 24 * 60 * 60 * 1000,

  _readCachedMetadata() {
    try {
      const raw = localStorage.getItem(this._metadataCacheKey);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || obj.issuer !== this.config.issuer) return null;
      if (!obj.meta || !obj.meta.authorization_endpoint || !obj.meta.token_endpoint) return null;
      return obj;
    } catch (_) { return null; }
  },

  async _fetchMetadata() {
    if (this.metadata) return this.metadata;

    // 冷啟動先吃 localStorage 快取（24h 內視為新鮮）——行動網路下 .well-known
    // 抓不到就不會卡住續期 / 登入健康檢查。
    const cached = this._readCachedMetadata();
    if (cached && Date.now() - (cached.__fetchedAt || 0) < this._metadataFreshMs) {
      this.metadata = cached.meta;
      return cached.meta;
    }

    const issuer = this.config.issuer.replace(/\/+$/, "");
    const candidates = [this._joinUrl(issuer, ".well-known/openid-configuration")];

    if (issuer.endsWith("/oidc")) {
      candidates.push(this._joinUrl(issuer.slice(0, -5), ".well-known/openid-configuration"));
    } else {
      candidates.push(this._joinUrl(issuer, "oidc/.well-known/openid-configuration"));
    }

    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) {
          lastError = new Error(`OIDC discovery failed: ${response.status} ${url}`);
          continue;
        }

        const metadata = await response.json();
        if (metadata.authorization_endpoint && metadata.token_endpoint) {
          this.metadata = metadata;
          try {
            localStorage.setItem(this._metadataCacheKey, JSON.stringify({
              meta: metadata, issuer: this.config.issuer, __fetchedAt: Date.now()
            }));
          } catch (_) {}
          return metadata;
        }
      } catch (err) {
        lastError = err;
      }
    }

    // 全部抓失敗：只要有舊快取就用（過期也用），別讓網路抖動變成「請重新登入」。
    if (cached) {
      this.metadata = cached.meta;
      return cached.meta;
    }

    throw lastError || new Error("OIDC discovery failed");
  },

  async _getEndpoints() {
    const metadata = await this._fetchMetadata();
    return {
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      endSessionEndpoint: metadata.end_session_endpoint || metadata.logout_endpoint || this._joinUrl(this.config.issuer, "auth/logout")
    };
  },

  _generateCodeVerifier() {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    return this._base64urlencode(bytes);
  },

  _sha256(plain) {
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  },

  _base64urlencode(buffer) {
    let str = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i += 1) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },

  async _generateCodeChallenge(verifier) {
    return this._base64urlencode(await this._sha256(verifier));
  },

  _parseJwt(token) {
    try {
      const base64Url = token.split(".")[1];
      if (!base64Url) return null;
      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split("")
          .map(char => "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
      return JSON.parse(jsonPayload);
    } catch (err) {
      console.error("Failed to parse JWT:", err);
      return null;
    }
  },

  _getRedirectUri() {
    return window.location.origin + "/";
  },

  _cleanCallbackUrl() {
    const url = new URL(window.location.href);
    [
      "code",
      "state",
      "error",
      "error_description",
      "scope",
      "iss",
      "auth_continuation",
      "auth_bridge_attempted",
      "openExternalBrowser",
      "version",
      "flow_id"
    ].forEach((key) => url.searchParams.delete(key));

    const urlSearch = url.search;
    const cleanUrl = `${url.origin}${url.pathname}${urlSearch}${url.hash}`;
    window.history.replaceState({}, document.title, cleanUrl);
  },

  _clearStoredTokens() {
    localStorage.removeItem(this.keys.accessToken);
    localStorage.removeItem(this.keys.idToken);
    localStorage.removeItem(this.keys.refreshToken);
    localStorage.removeItem(this.keys.expiresAt);
    localStorage.removeItem(this.keys.memberContext);
    localStorage.removeItem(this.keys.supabaseAccessToken);
    localStorage.removeItem(this.keys.supabaseExpiresAt);
    localStorage.removeItem(this.keys.supabaseProfile);
    localStorage.removeItem("nlc_edge_session_expires_at");
    localStorage.removeItem("nlc_profile_locked_fields");
    // NOTE: active_reading_plans / reading_logs / selected_plan_key are intentionally
    // NOT cleared here — they belong to user data, not auth tokens.
    // They are only cleared on explicit logout() to avoid wiping local cache
    // when a token refresh fails (e.g. on Android bridge re-auth).
  },

  _getFlowItem(key) {
    return sessionStorage.getItem(key) || localStorage.getItem(key);
  },

  _setFlowItem(key, value) {
    sessionStorage.setItem(key, value);
    localStorage.setItem(key, value);
  },

  _clearFlowState() {
    [
      this.keys.state,
      this.keys.verifier,
      this.keys.nonce,
      this.keys.continuation,
      this.keys.continuationVersion,
      this.keys.flowId
    ].forEach((key) => {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    });
  },

  _normalizeAuthContinuationInput(input = {}) {
    const parsedInput =
      typeof input === "string"
        ? parseAuthContinuation(input)
        : (typeof input === "object" && input !== null ? input : {});

    if (parsedInput && parsedInput.version === AUTH_POLICY_VERSION && parsedInput.flowId) {
      return {
        version: AUTH_POLICY_VERSION,
        intent: parsedInput.intent,
        returnTo: cleanReturnTo(parsedInput.returnTo || "/"),
        target: parsedInput.target,
        flowId: parsedInput.flowId
      };
    }

    const continuationFromQuery = parseContinuationFromSearchParams(window.location.search);
    if (continuationFromQuery) {
      return continuationFromQuery;
    }

    try {
      return createAuthContinuation({
        intent: typeof parsedInput.intent === "string" ? parsedInput.intent : "login",
        returnTo: typeof input === "string" ? input : parsedInput.returnTo || "/",
        target: parsedInput.target
      });
    } catch {
      return createAuthContinuation({ intent: "login", returnTo: "/" });
    }
  },

  _resetAppAuthState() {
    state.currentUser = {
      name: "",
      great_region: "",
      pastoral_zone: "",
      small_group: "",
      role_id: "10000000-0000-4000-8000-000000000001",
      role_definition: null,
      chapters_read: 0,
      plan_progress: 0,
      streak: 0,
      last_read: null,
      member_context_synced_at: "",
      member_context_sync_attempted_at: "",
      member_context_sync_status: "",
      member_context_sync_error: "",
      member_context_contract_version: "",
      member_context_membership_lifecycle_state: "",
      member_context_placement_state: "",
      member_context_placement_workflow_state: "",
      member_context_has_required_placement: "",
      member_context_required_action: "",
      member_context_required_action_url: ""
    };
    state.readingLogs = [];
    state.activePlans = [];
    state.activePlan = null;
    state.currentProfileId = null;
    state.profileLockedFields = [];
    if (typeof db !== "undefined" && typeof db.resetOrgStructure === "function") {
      db.resetOrgStructure();
    }
  },

  _showMessage(message) {
    if (typeof showToast === "function") showToast(message);
    else alert(message);
  },
  markLoginFailure() {
    window.__nlcLoginRepairRequired = true;
    try {
      localStorage.setItem(this.keys.repairRequired, String(Date.now()));
    } catch (error) {
      console.warn("Could not persist login repair state", error);
    }
    const button = document.getElementById("btn-gate-nlc-login");
    if (button) button.textContent = "修復並重新登入";
  },

  shouldRepairBeforeLogin() {
    if (window.__nlcLoginRepairRequired) return true;
    try {
      return Boolean(localStorage.getItem(this.keys.repairRequired));
    } catch {
      return false;
    }
  },

  startLoginRepair() {
    const repairUrl = new URL("/repair", window.location.origin);
    repairUrl.searchParams.set("resume_login", "1");
    repairUrl.searchParams.set("version", String(Date.now()));
    window.location.assign(repairUrl.toString());
  },

  clearLoginRepairState() {
    window.__nlcLoginRepairRequired = false;
    try {
      localStorage.removeItem(this.keys.repairRequired);
    } catch (error) {
      console.warn("Could not clear login repair state", error);
    }
  },

  _addBrowserLaunchTransportParams(targetUrl) {
    try {
      const url = new URL(targetUrl, window.location.origin);
      url.searchParams.set("openExternalBrowser", "1");
      return url.toString();
    } catch {
      return targetUrl;
    }
  },

  _buildBridgeUrl(continuation, authEnvironment) {
    const base = new URL(window.location.href);
    const cleanUrl = new URL(base.pathname + base.hash, base.origin);
    for (const [name, value] of base.searchParams.entries()) {
      if (["code", "state", "error", "error_description", "openExternalBrowser", "auth_bridge_attempted", "auth_continuation", "version"].includes(name)) {
        continue;
      }
      cleanUrl.searchParams.append(name, value);
    }

    cleanUrl.searchParams.set("auth_bridge_attempted", "1");
    cleanUrl.searchParams.set("auth_continuation", continuation || "");
    cleanUrl.searchParams.set("version", String(typeof AUTH_POLICY_VERSION !== "undefined" ? AUTH_POLICY_VERSION : "1"));

    return this._addBrowserLaunchTransportParams(cleanUrl.toString());
  },

  _isIntentOpenRecommended(authEnvironment) {
    return !!(authEnvironment && authEnvironment.platform === "android" && authEnvironment.decision === "bridge");
  },

  // Build an Android Intent URL that opens the target URL in the device's default browser.
  _externalBrowserIntentUrl(targetUrl) {
    const url = new URL(targetUrl);
    const scheme = url.protocol.replace(":", "");
    const fallback = encodeURIComponent(targetUrl);
    return `intent://${url.host}${url.pathname}${url.search}${url.hash}` +
      `#Intent;scheme=${scheme};action=android.intent.action.VIEW;` +
      `category=android.intent.category.BROWSABLE;` +
      `S.browser_fallback_url=${fallback};end`;
  },

  // Build a list of intent URLs to try in order, from most-specific to least-specific.
  _externalBrowserIntentFallbacks(targetUrl) {
    const url = new URL(targetUrl);
    const scheme = url.protocol.replace(":", "");
    const path = `${url.host}${url.pathname}${url.search}${url.hash}`;
    const fallback = encodeURIComponent(targetUrl);
    const base = `#Intent;scheme=${scheme};S.browser_fallback_url=${fallback};`;
    return [
      `intent://${path}${base}action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`,
      `intent://${path}${base}package=com.android.chrome;end`,
      `intent://${path}${base}package=com.sec.android.app.sbrowser;end`,
      `intent://${path}${base}package=org.mozilla.firefox;end`,
    ];
  },

  _startSystemBrowserTransition(continuation, authEnvironment) {
    const bridgeUrl = this._buildBridgeUrl(continuation || "", authEnvironment);

    // Standard HTTPS navigation with openExternalBrowser=1.
    // Standard https:// URLs do NOT trigger iOS "此網站正在嘗試開啟外部應用程式" system dialogs.
    // LINE on both iOS and Android natively catches openExternalBrowser=1 and opens Safari/Chrome.
    window.location.href = bridgeUrl;
  },

  showEmbeddedBrowserAuthDialog(authEnvironment, continuation) {
    const safeContinuation = this._normalizeAuthContinuationInput(continuation);
    const serializedContinuation = serializeAuthContinuation(safeContinuation);
    this._setFlowItem(this.keys.continuation, serializedContinuation);

    // Update status on the login page button itself — keep user on clean login page
    const gateBtn = document.getElementById("btn-gate-nlc-login");
    if (gateBtn) {
      gateBtn.disabled = true;
      gateBtn.textContent = "正在開啟瀏覽器...";
    }

    // Immediately perform clean HTTPS redirect without any modal popups or custom scheme dialogs
    this._startSystemBrowserTransition(serializedContinuation, authEnvironment);
  },


  _failCallback(message, detail) {
    if (detail) console.error(message, detail);
    this._clearFlowState();
    this._clearStoredTokens();
    this._resetAppAuthState();
    this.markLoginFailure();
    this._cleanCallbackUrl();
    if (typeof db !== "undefined" && db.updateAuthUI) db.updateAuthUI(null);
    this._showMessage(message || "\u6559\u6703\u7cfb\u7d71\u767b\u5165\u5931\u6557\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002");
    return true;
  },

  _applyTokenProfileFallback() {
    const payload = this._parseJwt(localStorage.getItem(this.keys.idToken) || "");
    if (!payload) return;
    const name = (typeof getDisplayName === "function"
      ? getDisplayName(payload.name || payload.nickname || payload.preferred_username || payload.email || "")
      : String(payload.name || payload.nickname || payload.preferred_username || payload.email || "").trim()) || "";
    state.currentUser.name = name;
    state.currentUser.role_id = state.currentUser.role_id || "10000000-0000-4000-8000-000000000001";
    state.currentUser.role_definition = state.currentUser.role_definition || getRoleDefinition(state.currentUser.role_id);
  },

  async resetLocalLogin() {
    this._clearFlowState();
    this._clearStoredTokens();
    this._resetAppAuthState();
    localStorage.removeItem("nlc_supabase_access_token");
    localStorage.removeItem("nlc_supabase_expires_at");
    localStorage.removeItem("nlc_supabase_profile");
    localStorage.removeItem("nlc_edge_session_expires_at");
    if (typeof state !== "undefined") {
      state.currentProfileId = null;
      if (state.supabaseConfig && typeof db !== "undefined" && db.createSupabaseClient) {
        state.supabase = db.createSupabaseClient();
      }
    }
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key =>
          // Only clear runtime caches (API responses) and legacy church-bible prefix.
          // Static app shell caches (newlife-bible-static-*) are intentionally preserved:
          // SW version management (cleanup on activate) handles static cache invalidation
          // when a new build is deployed. Clearing static cache here forces a full
          // re-download of all JS/CSS/icons on every login, which harms offline experience.
          key.startsWith("newlife-bible-runtime-") ||
          key.startsWith("church-bible-")
        ).map(key => caches.delete(key)));
      }
    } catch (err) {
      console.warn("Could not clear app caches", err);
    }
  },

  async startInteractiveLogin(continuation) {
    try {
      await this.resetLocalLogin();
      if (!this.config.clientId) {
        console.error("NLC OIDC clientId is missing. Set NLC_CLIENT_ID and rebuild config.js.");
        alert("\u6559\u6703\u7cfb\u7d71\u767b\u5165\u5c1a\u672a\u5b8c\u6210\u8a2d\u5b9a\uff0c\u8acb\u806f\u7d61\u7ba1\u7406\u54e1\u3002");
        return;
      }

      const safeContinuation = this._normalizeAuthContinuationInput(continuation);
      const stateVal = this._generateCodeVerifier();
      const verifierVal = this._generateCodeVerifier();
      const nonceVal = this._generateCodeVerifier();
      const challenge = await this._generateCodeChallenge(verifierVal);
      if (!/^[0-9A-Z]{26}$/.test(safeContinuation.flowId || "")) {
        safeContinuation.flowId = createAuthContinuation({
          intent: safeContinuation.intent,
          returnTo: safeContinuation.returnTo
        }).flowId;
      }

      const serializedContinuation = serializeAuthContinuation(safeContinuation);

      this._clearFlowState();
      this._setFlowItem(this.keys.state, stateVal);
      this._setFlowItem(this.keys.verifier, verifierVal);
      this._setFlowItem(this.keys.nonce, nonceVal);
      this._setFlowItem(this.keys.continuation, serializedContinuation);
      this._setFlowItem(this.keys.continuationVersion, String(AUTH_POLICY_VERSION));
      this._setFlowItem(this.keys.flowId, safeContinuation.flowId);

      const redirectUri = this._getRedirectUri();
      const endpoints = await this._getEndpoints();
      const authParams = new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: this.config.scopes,
        state: stateVal,
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: nonceVal
      });
      if (this.config.platformResource) {
        authParams.set("resource", this.config.platformResource);
      }

      window.location.href = `${endpoints.authorizationEndpoint}?${authParams}`;
    } catch (err) {
      console.error("Logto login redirect failed:", err);
      this.markLoginFailure();
      this._showMessage("\u7121\u6cd5\u958b\u555f\u6559\u6703\u7cfb\u7d71\u767b\u5165\uff0c\u8acb\u91cd\u8a66\u3002");
    }
  },


  async login(options = {}) {
    return this.startInteractiveLogin(options);
  },

  async continueFromContinuation(continuation) {
    await this.startInteractiveLogin(continuation);
  },

  async maybeResumeInteractiveAuthFromBridge() {
    const continuation = parseContinuationFromSearchParams(window.location.search);
    if (!continuation) return false;

    const continuationFromLocation = continuation;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("code") || urlParams.has("state") || urlParams.has("error")) {
      return false;
    }

    if (!continuation) return false;
    const environment = detectAuthenticationEnvironment();
    if (shouldGateInteractiveAuth(environment, { authEnvironmentAcknowledged: false })) {
      this.showEmbeddedBrowserAuthDialog(environment, continuationFromLocation);
      return false;
    }

    return this.startInteractiveLogin(continuationFromLocation);
  },

  async handleCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const stateVal = urlParams.get("state");
    const authError = urlParams.get("error");
    const authErrorDescription = urlParams.get("error_description");

    if (authError) {
      return this._failCallback("\u6559\u6703\u7cfb\u7d71\u767b\u5165\u5931\u6557\uff1a" + (authErrorDescription || authError), { authError, authErrorDescription });
    }

    if (!code && !stateVal) return false;
    if (!code || !stateVal) return this._failCallback("\u6559\u6703\u7cfb\u7d71\u767b\u5165\u8cc7\u6599\u4e0d\u5b8c\u6574\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002", { code: !!code, state: !!stateVal });

    const savedState = this._getFlowItem(this.keys.state);
    if (!savedState || savedState !== stateVal) {
      return this._failCallback("\u767b\u5165\u9a57\u8b49\u5df2\u904e\u671f\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002", { savedState: !!savedState, callbackState: !!stateVal });
    }

    const verifier = this._getFlowItem(this.keys.verifier);
    if (!verifier) return this._failCallback("\u767b\u5165\u9a57\u8b49\u8cc7\u6599\u907a\u5931\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002");

    const nonce = this._getFlowItem(this.keys.nonce);
    if (!nonce) return this._failCallback("\u767b\u5165\u9a57\u8b49\u6c92\u6709\u6240\u9700\u7684\u76f8\u95dc\u8cc7\u8a0a\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002");

    loader.show("\u6b63\u5728\u5b8c\u6210\u6559\u6703\u7cfb\u7d71\u767b\u5165...");
    try {
      const redirectUri = this._getRedirectUri();
      const endpoints = await this._getEndpoints();
      const tokenParams = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: this.config.clientId,
        code_verifier: verifier
      };
      if (this.config.platformResource) {
        tokenParams.resource = this.config.platformResource;
      }

      const response = await fetch(endpoints.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(tokenParams)
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Token exchange failed: ${response.status} ${response.statusText}${errorText ? " - " + errorText : ""}`);
      }

      const data = await response.json();
      const idPayload = this._parseJwt(data.id_token || "");
      if (!idPayload || idPayload.nonce !== nonce) {
        return this._failCallback("\u767b\u5165\u9a57\u8b49\u5931\u6557\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002", {
          missingIdToken: !data.id_token,
          expectedNonce: !!nonce,
          hasPayload: !!idPayload
        });
      }

      this._saveTokens(data);
      // \u767b\u5165\u6210\u529f\u5f8c\u8df3\u56de\u539f\u672c\u90a3\u4e00\u9801\uff08\u4f8b\u5982\u6279\u6539\u9801 /grade.html?paper=\u2026&attempt=\u2026\uff09\uff0c
      // \u800c\u4e0d\u662f\u6c38\u9060\u505c\u5728\u9996\u9801\u2014\u2014continuation \u5728 startInteractiveLogin() \u5b58\u7684
      // returnTo \u5c31\u662f\u70ba\u4e86\u9019\u4e00\u523b\uff0c\u5148\u524d\u9019\u88e1\u5f9e\u6c92\u8b80\u51fa\u4f86\u7528\u904e\u3002
      const continuation = parseAuthContinuation(this._getFlowItem(this.keys.continuation));
      const returnTo = continuation && continuation.returnTo;
      this._cleanCallbackUrl();
      this._applyTokenProfileFallback();
      this._showMessage("\u6559\u6703\u7cfb\u7d71\u767b\u5165\u6210\u529f\u3002");
      if (returnTo && returnTo !== "/" && returnTo !== window.location.pathname + window.location.search) {
        window.location.replace(returnTo);
        return true;
      }
      return true;
    } catch (err) {
      return this._failCallback("\u6559\u6703\u7cfb\u7d71\u767b\u5165\u5931\u6557\uff0c\u8acb\u91cd\u65b0\u767b\u5165\u3002", err);
    } finally {
      this._clearFlowState();
      loader.hide();
    }
  },

  _saveTokens(tokenResponse) {
    this.clearLoginRepairState();
    if (tokenResponse.access_token) localStorage.setItem(this.keys.accessToken, tokenResponse.access_token);
    if (tokenResponse.id_token) localStorage.setItem(this.keys.idToken, tokenResponse.id_token);
    if (tokenResponse.refresh_token) localStorage.setItem(this.keys.refreshToken, tokenResponse.refresh_token);
    if (tokenResponse.expires_in) {
      localStorage.setItem(this.keys.expiresAt, String(Date.now() + tokenResponse.expires_in * 1000));
    }
    this.scheduleProactiveRefresh();
  },

  _proactiveRefreshTimer: null,

  // Keeps the access token refreshed slightly ahead of its real expiry so an
  // app left open — but idle, with nothing triggering the usual
  // reactive refresh-on-401 path — never silently drifts into an expired
  // token. Only fires while the tab is visible; background tabs can have
  // their timers throttled or fully suspended by the browser, so a
  // visibilitychange listener (registered once, at the bottom of this file)
  // re-arms this every time the tab is foregrounded again, which also covers
  // the case where the scheduled moment was missed entirely while hidden.
  scheduleProactiveRefresh() {
    if (typeof window === "undefined") return;
    if (this._proactiveRefreshTimer) {
      clearTimeout(this._proactiveRefreshTimer);
      this._proactiveRefreshTimer = null;
    }
    const refreshToken = localStorage.getItem(this.keys.refreshToken);
    const expiresAt = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
    if (!refreshToken || !expiresAt) return;

    // 15 分鐘 token 提前 6 分鐘續（約第 9 分鐘）——留足夠餘裕，續期失敗還有第 2、3 次機會。
    const REFRESH_BUFFER_MS = 6 * 60 * 1000;
    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_BUFFER_MS);

    this._proactiveRefreshTimer = setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Backgrounded — let the visibilitychange listener re-arm this on
        // return instead of refreshing while nothing is watching.
        return;
      }
      this.refreshTokens().finally(() => this.scheduleProactiveRefresh());
    }, delay);
  },

  _refreshPromise: null,

  // 實際打 Logto token 端點。進來前假設已拿到跨情境鎖（或環境沒有 navigator.locks）。
  // startExpiresAt = 呼叫端在搶鎖前看到的到期時間，用來判斷「等鎖期間有沒有別的情境已換好」。
  async _doRefreshOnce(startExpiresAt) {
    // 搶到鎖之後先看 localStorage：另一個分頁 / 測驗滿版頁可能剛換好一張還很新的，
    // 就直接用，不要再拿（可能已被輪替掉的）refresh token 去打 Logto。
    const freshTok = localStorage.getItem(this.keys.accessToken);
    const freshExp = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
    if (freshTok && freshExp > (startExpiresAt || 0) && Date.now() < freshExp - 90000) {
      this.scheduleProactiveRefresh();
      return true;
    }

    const refreshToken = localStorage.getItem(this.keys.refreshToken);
    if (!refreshToken) return false;

    try {
      const endpoints = await this._getEndpoints();
      const refreshParams = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.config.clientId
      });
      if (this.config.platformResource) {
        refreshParams.set("resource", this.config.platformResource);
      }
      if (this.config.scopes) {
        refreshParams.set("scope", this.config.scopes);
      }

      const response = await fetch(endpoints.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: refreshParams
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const refreshError = new Error(`OIDC refresh failed: ${response.status}${errorText ? " - " + errorText : ""}`);
        refreshError.authRejected = [400, 401, 403].includes(response.status);
        throw refreshError;
      }

      this._saveTokens(await response.json());
      return true;
    } catch (err) {
      console.error("Logto token refresh error:", err);
      if (err?.authRejected) {
        // Logto 拒了這張 refresh token。常見假警報：另一個情境剛把它輪替掉、
        // 這個 context 手上的是舊的。鎖內再確認一次——真的有更新的 access token
        // 就當成功，不要清掉登入狀態。
        const afterTok = localStorage.getItem(this.keys.accessToken);
        const afterExp = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
        if (afterTok && afterExp > (startExpiresAt || 0) && Date.now() < afterExp - 90000) return true;
        this._clearStoredTokens();
        localStorage.removeItem("offline_trusted_identity");
        return false;
      }
      // Discovery/network failures do not mean the account was rejected.
      // Keep the refresh token so the trusted device can resume when online.
      return null;
    }
  },

  async refreshTokens() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    const startExpiresAt = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
    this._refreshPromise = (async () => {
      // 跨「所有同源情境」序列化續期：Safari 分頁 + 加到主畫面的 PWA + 測驗滿版頁
      // 不會各自拿 refresh token 去打 Logto、互相把對方輪替掉（登出的最大宗）。
      const locks = (typeof navigator !== "undefined" && navigator.locks && navigator.locks.request)
        ? navigator.locks : null;
      if (locks) {
        try {
          return await locks.request("nlc-token-refresh", { mode: "exclusive" },
            () => this._doRefreshOnce(startExpiresAt));
        } catch (lockErr) {
          console.warn("token-refresh lock unavailable; refreshing without it", lockErr);
        }
      }
      return await this._doRefreshOnce(startExpiresAt);
    })();

    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  },

  isLoggedIn() {
    const token = localStorage.getItem(this.keys.accessToken);
    const refreshToken = localStorage.getItem(this.keys.refreshToken);
    const expiresAt = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
    return (!!token && Date.now() < expiresAt) || !!refreshToken;
  },

  async getValidAccessToken(forceRefresh = false) {
    const token = localStorage.getItem(this.keys.accessToken);
    const refreshToken = localStorage.getItem(this.keys.refreshToken);
    const expiresAt = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
    // 120 秒 skew（原本 60）：續期來回在 3G 上可能 > 60 秒、廉價 Android 時鐘也常偏差。
    const CLOCK_SKEW_MS = 120000;
    const shouldRefresh = forceRefresh || !token || Date.now() > expiresAt - CLOCK_SKEW_MS;

    if (forceRefresh && !refreshToken && token && Date.now() < expiresAt - CLOCK_SKEW_MS) {
      console.warn("force_refresh_without_refresh_token: using still-valid Logto access token.");
      return token;
    }

    if (shouldRefresh) {
      let refreshed = await this.refreshTokens();
      // 續期回 null＝網路 / 尖峰把 Logto 續期端點打爆（不是帳號被拒）。
      // 固定時段開放的大測驗，所有人 token 會同時到期、同時打續期端點，
      // 立刻放棄就會讓「送出當下」剛好失敗。短暫退避後再試 2 次。
      for (let i = 0; refreshed === null && i < 2; i++) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        refreshed = await this.refreshTokens();
      }
      if (refreshed === null) {
        const offlineError = new Error("目前無法連線驗證登入狀態。");
        offlineError.code = "OFFLINE_AUTH_UNAVAILABLE";
        throw offlineError;
      }
      if (!refreshed) {
        // refreshTokens() 回 false＝Logto 明確拒絕了這份 refresh token。
        // 但常見的假警報：**另一個分頁 / 獨立測驗頁剛把 refresh token 輪替掉**，
        // 這個 context 手上的是舊的、被拒屬正常。先重讀 localStorage——
        // 若別處已換好還沒過期的 access token，直接用，不要清掉登入狀態
        // （清掉會讓 app.js 的健康檢查偵測到 !currentUser.name → 再 loadUserData → 迴圈）。
        const sharedToken = localStorage.getItem(this.keys.accessToken);
        const sharedExp = parseInt(localStorage.getItem(this.keys.expiresAt) || "0", 10);
        if (sharedToken && sharedToken !== token && Date.now() < sharedExp - 30000) {
          return sharedToken;
        }
        // 給另一個 context 一點時間完成輪替，再試最後一次
        await new Promise((r) => setTimeout(r, 1500));
        if (await this.refreshTokens()) {
          const t2 = localStorage.getItem(this.keys.accessToken);
          if (t2) return t2;
        }
        this._clearStoredTokens();
        this._resetAppAuthState();
        throw new Error("登入狀態已失效，請重新登入。");
      }
    }

    const nextToken = localStorage.getItem(this.keys.accessToken);
    if (!nextToken) throw new Error("登入狀態已失效，請重新登入。");
    if (this.config.platformResource && nextToken.split(".").length !== 3) {
      console.warn(
        "Logto access token is not a JWT. Platform API requires resource=",
        this.config.platformResource,
        "at login/refresh."
      );
    }
    return nextToken;
  },

  getLogtoSubject() {
    const payload = this._parseJwt(localStorage.getItem(this.keys.idToken) || "");
    return payload ? payload.sub : null;
  },

  _getTokenClientId(token) {
    const payload = this._parseJwt(token || "");
    if (!payload) return "";
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    return payload.azp || payload.client_id || aud || "";
  },

  _finishLocalLogout() {
    const cleanUrl = window.location.origin + window.location.pathname;
    window.location.replace(cleanUrl);
  },

  async logout() {
    this._clearStoredTokens();
    this._clearFlowState();
    this._resetAppAuthState();
    // Explicitly clear user data cache only on intentional logout
    localStorage.removeItem("active_reading_plans");
    localStorage.removeItem("reading_logs");
    localStorage.removeItem("selected_plan_key");
    localStorage.removeItem("offline_trusted_identity");
    // 螢光筆是本機優先合併（見 db.js loadUserData）——不清掉的話，同一台裝置
    // 換下一個人登入時,上一位的螢光筆記錄會被當成「我自己還沒同步的修改」
    // 留著，顯示出不是自己的紀錄，編輯到還會用新帳號把它寫回伺服器。
    localStorage.removeItem("bible_highlights");
    localStorage.removeItem("bible_highlight_timestamps");
    localStorage.removeItem("bible_highlights_owner");
    try { sessionStorage.removeItem("plan_elig_hub_verified"); } catch (_) {}

    if (typeof state !== "undefined" && state.supabase && state.supabase.auth && typeof state.supabase.auth.signOut === "function") {
      try {
        await state.supabase.auth.signOut();
      } catch (err) {
        console.warn("Supabase signOut failed during logout:", err);
      }
    }

    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith("newlife-bible-") || key.startsWith("church-bible-")).map(key => caches.delete(key)));
      }
    } catch (err) {
      console.warn("Could not clear app caches during logout", err);
    }

    this._finishLocalLogout();
  }
};

window.auth = auth;

if (typeof document !== "undefined") {
  // Re-arm the proactive refresh timer whenever the tab regains focus —
  // background tabs can have setTimeout throttled or fully suspended, so the
  // originally scheduled firing may never actually happen while hidden.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") auth.scheduleProactiveRefresh();
  });
}
