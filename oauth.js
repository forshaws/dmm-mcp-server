// oauth.js — Self-contained OAuth 2.1 Authorization Server for tqnn-mcp-server
// MCP Authorization Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
//
// Implements:
//   RFC 9728  — OAuth 2.0 Protected Resource Metadata
//   RFC 8414  — OAuth 2.0 Authorization Server Metadata
//   RFC 7591  — Dynamic Client Registration
//   OAuth 2.1 — Authorization Code + PKCE (S256), Refresh Tokens
//   RFC 8707  — Resource Indicators (resource parameter)
//
// All state is in-memory. On Pi5 restart, users re-authenticate.
// No database, no external dependencies, no npm packages beyond crypto (built-in).
//
// Token signing: HMAC-SHA256 with TQNN_MCP_SECRET from .env.
// Token format: base64url(header).base64url(payload).HMAC-SHA256(header.payload)
//
// Redirect URI registered for claude.ai (all surfaces):
//   https://claude.ai/api/mcp/auth_callback

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { URL } = require('url');

// ── Constants ──────────────────────────────────────────────────────────────────
const CLAUDE_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  // Claude Code loopback (port-agnostic matching applied in validation)
  'http://localhost/callback',
  'http://127.0.0.1/callback',
];

const SCOPES_SUPPORTED = ['tqnn:read', 'tqnn:write'];
const ACCESS_TOKEN_TTL  = 3600;        // 1 hour
const REFRESH_TOKEN_TTL = 30 * 86400;  // 30 days
const AUTH_CODE_TTL     = 300;         // 5 minutes
const CODE_VERIFIER_LEN = { min: 43, max: 128 };

// ── In-memory stores ───────────────────────────────────────────────────────────
/** @type {Map<string, Client>} clientId → Client */
const clients       = new Map();
/** @type {Map<string, AuthCode>} code → AuthCode */
const authCodes     = new Map();
/** @type {Map<string, AccessToken>} token → AccessToken */
const accessTokens  = new Map();
/** @type {Map<string, RefreshToken>} token → RefreshToken */
const refreshTokens = new Map();

// Pending auth requests (code_challenge stored before redirect)
/** @type {Map<string, PendingAuth>} state → PendingAuth */
const pendingAuths  = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.isBuffer(buf)
    ? buf.toString('base64url')
    : Buffer.from(buf, 'utf8').toString('base64url');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hmacSign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function now() { return Math.floor(Date.now() / 1000); }

// ── Per-employee users file (tqnn_mcp_users.json) ───────────────────────────────
// Replaces the single shared admin login when present. Each user has their own
// username/password and an active/disabled status that is checked LIVE on every
// single MCP request (not just at login) — disabling a user here revokes their
// access immediately, even if they're holding an unexpired token.
//
// If this file is absent, oauth.js falls back to the legacy single admin
// user/pass from .env (TQNN_OAUTH_USER / TQNN_OAUTH_PASS) — nothing breaks
// on a fresh install or before you've set up per-employee accounts.
const USERS_FILE = path.join(__dirname, 'tqnn_mcp_users.json');
let _usersCache  = null;
let _usersMtime  = 0;

function loadUsers() {
  try {
    const stat = fs.statSync(USERS_FILE);
    if (_usersCache && stat.mtimeMs === _usersMtime) return _usersCache;
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _usersCache = (parsed && typeof parsed.users === 'object') ? parsed.users : {};
    _usersMtime = stat.mtimeMs;
    return _usersCache;
  } catch {
    // File missing, unreadable, or invalid JSON — treat as "no per-user accounts configured"
    return null;
  }
}

/**
 * Is this username currently allowed to authenticate / stay authenticated?
 * Re-reads tqnn_mcp_users.json (cheap — cached by mtime) so edits to the file
 * take effect on the very next check, no restart required.
 * @param {string} username
 * @returns {boolean}
 */
function isUserActive(username) {
  const users = loadUsers();
  if (!users) return true; // no per-user file — legacy single-admin mode, always "active"
  const entry = users[username];
  return !!entry && entry.status === 'active';
}

/**
 * Hash a password for storage in tqnn_mcp_users.json.
 * Uses scrypt (Node built-in, no extra dependency) — format: "salt_hex:hash_hex".
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a "salt_hex:hash_hex" stored value.
 * Constant-time comparison.
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  try {
    const computed = crypto.scryptSync(password, saltHex, 64);
    const expected = Buffer.from(hashHex, 'hex');
    if (computed.length !== expected.length) return false;
    return crypto.timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}

/**
 * Verify S256 PKCE.
 * code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 */
function pkceVerify(verifier, challenge) {
  if (!verifier || !challenge) return false;
  if (verifier.length < CODE_VERIFIER_LEN.min || verifier.length > CODE_VERIFIER_LEN.max) return false;
  const digest = crypto.createHash('sha256').update(verifier, 'ascii').digest();
  const expected = b64url(digest);
  // Constant-time comparison
  if (expected.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(challenge));
}

/**
 * Validate a redirect_uri against a registered client.
 * For localhost/127.0.0.1 (Claude Code), we do port-agnostic matching.
 */
function validateRedirectUri(registered, presented) {
  if (!presented) return false;
  // Exact match first
  if (registered.includes(presented)) return true;
  // Port-agnostic localhost matching for Claude Code
  try {
    const p = new URL(presented);
    const isLoopback = p.hostname === 'localhost' || p.hostname === '127.0.0.1';
    if (!isLoopback) return false;
    // Strip port from presented and compare against registered loopback entries
    const normalized = `${p.protocol}//${p.hostname}${p.pathname}${p.search}`;
    return registered.some(r => {
      try {
        const u = new URL(r);
        const uLoop = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (!uLoop) return false;
        const rNorm = `${u.protocol}//${u.hostname}${u.pathname}`;
        return normalized.startsWith(rNorm);
      } catch { return false; }
    });
  } catch { return false; }
}

// ── OAuthServer class ──────────────────────────────────────────────────────────
class OAuthServer {
  /**
   * @param {object} opts
   * @param {string} opts.publicUrl   - Canonical public URL of the MCP server (ngrok URL)
   * @param {string} opts.secret      - HMAC secret for token signing
   * @param {string} opts.adminUser   - Username for the auth consent page
   * @param {string} opts.adminPass   - Password for the auth consent page (stored hashed)
   */
  constructor({ publicUrl, secret, adminUser, adminPass }) {
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.secret    = secret;
    this.adminUser = adminUser;
    // Store password as SHA-256 hex (never plaintext after construction)
    this.adminPassHash = crypto.createHash('sha256').update(adminPass, 'utf8').digest('hex');
    // Derived URLs
    this.issuerUrl      = this.publicUrl;
    this.authEndpoint   = `${this.publicUrl}/oauth/authorize`;
    this.tokenEndpoint  = `${this.publicUrl}/oauth/token`;
    this.registerEndpoint = `${this.publicUrl}/oauth/register`;
  }

  // ── Protected Resource Metadata (RFC 9728) ──────────────────────────────────
  // Served at /.well-known/oauth-protected-resource
  protectedResourceMetadata() {
    return {
      resource:             this.publicUrl,
      authorization_servers: [this.issuerUrl],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://github.com/forshaws/dmm-mcp-server'
    };
  }

  // ── Authorization Server Metadata (RFC 8414) ────────────────────────────────
  // Served at /.well-known/oauth-authorization-server
  authorizationServerMetadata() {
    return {
      issuer:                            this.issuerUrl,
      authorization_endpoint:            this.authEndpoint,
      token_endpoint:                    this.tokenEndpoint,
      registration_endpoint:             this.registerEndpoint,
      response_types_supported:          ['code'],
      grant_types_supported:             ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported:  ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported:                  SCOPES_SUPPORTED,
      subject_types_supported:           ['public'],
      // RFC 8707 resource indicators
      resource_indicators_supported:     true
    };
  }

  // ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────
  // POST /oauth/register
  registerClient(body) {
    const clientId     = `tqnn_${randomToken(16)}`;
    const clientSecret = randomToken(32);

    const redirectUris = body.redirect_uris || CLAUDE_REDIRECT_URIS;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return { error: 'invalid_redirect_uri', error_description: 'redirect_uris required' };
    }

    const client = {
      client_id:                  clientId,
      client_secret:              clientSecret,
      client_id_issued_at:        now(),
      client_secret_expires_at:   0, // never
      redirect_uris:              redirectUris,
      grant_types:                body.grant_types || ['authorization_code', 'refresh_token'],
      response_types:             body.response_types || ['code'],
      client_name:                body.client_name || 'MCP Client',
      scope:                      body.scope || SCOPES_SUPPORTED.join(' '),
    };

    clients.set(clientId, client);
    process.stderr.write(`[tqnn-oauth] DCR: registered client ${clientId} (${client.client_name})\n`);
    return client;
  }

  // ── Authorization Endpoint ──────────────────────────────────────────────────
  // GET /oauth/authorize
  // Returns { action: 'render_form', html } or { action: 'redirect_error', ... }
  handleAuthorizeRequest(query) {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method, scope, resource } = query;

    if (response_type !== 'code') {
      return { action: 'error', status: 400, error: 'unsupported_response_type' };
    }
    const client = clients.get(client_id);
    if (!client) {
      return { action: 'error', status: 400, error: 'invalid_client', error_description: 'Unknown client_id' };
    }
    if (!validateRedirectUri(client.redirect_uris, redirect_uri)) {
      return { action: 'error', status: 400, error: 'invalid_redirect_uri' };
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      return { action: 'redirect_error', redirect_uri, state, error: 'invalid_request', error_description: 'PKCE S256 required' };
    }

    // Store pending auth
    const pendingState = state || randomToken(16);
    pendingAuths.set(pendingState, {
      client_id, redirect_uri, code_challenge, scope: scope || SCOPES_SUPPORTED.join(' '),
      resource: resource || this.publicUrl,
      created_at: now()
    });

    // Render consent/login page
    const html = this._renderAuthForm(pendingState, client.client_name, scope);
    return { action: 'render_form', html };
  }

  // POST /oauth/authorize (form submission)
  handleAuthorizeSubmit(body) {
    const { state, username, password } = body;

    const pending = pendingAuths.get(state);
    if (!pending) {
      return { action: 'error', status: 400, error: 'invalid_state' };
    }

    // Check if user denied
    if (body.action === 'deny') {
      pendingAuths.delete(state);
      const url = new URL(pending.redirect_uri);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      return { action: 'redirect', location: url.toString() };
    }

    // Validate credentials
    const authenticatedUser = this._checkCredentials(username, password);
    if (!authenticatedUser) {
      const html = this._renderAuthForm(state, '', pending.scope, 'Invalid credentials. Please try again.');
      return { action: 'render_form', html };
    }

    // Issue authorization code
    const code = randomToken(32);
    authCodes.set(code, {
      client_id:      pending.client_id,
      redirect_uri:   pending.redirect_uri,
      code_challenge: pending.code_challenge,
      scope:          pending.scope,
      resource:       pending.resource,
      username:       authenticatedUser,
      created_at:     now()
    });
    pendingAuths.delete(state);

    // Cleanup expired codes periodically
    this._cleanupExpired();

    const redirectUrl = new URL(pending.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return { action: 'redirect', location: redirectUrl.toString() };
  }

  // ── Token Endpoint ──────────────────────────────────────────────────────────
  // POST /oauth/token
  handleTokenRequest(body) {
    const { grant_type } = body;

    if (grant_type === 'authorization_code') {
      return this._handleAuthCodeGrant(body);
    } else if (grant_type === 'refresh_token') {
      return this._handleRefreshGrant(body);
    }
    return { error: 'unsupported_grant_type' };
  }

  _handleAuthCodeGrant(body) {
    const { code, client_id, redirect_uri, code_verifier } = body;

    const stored = authCodes.get(code);
    if (!stored) {
      return { error: 'invalid_grant', error_description: 'Authorization code not found or expired' };
    }
    if (now() - stored.created_at > AUTH_CODE_TTL) {
      authCodes.delete(code);
      return { error: 'invalid_grant', error_description: 'Authorization code expired' };
    }
    if (stored.client_id !== client_id) {
      return { error: 'invalid_client', error_description: 'client_id mismatch' };
    }
    if (redirect_uri && stored.redirect_uri !== redirect_uri) {
      return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
    }
    if (!pkceVerify(code_verifier, stored.code_challenge)) {
      return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
    }

    // Code is single-use
    authCodes.delete(code);

    const client = clients.get(client_id);
    if (!client) return { error: 'invalid_client' };

    const accessToken  = this._issueAccessToken(client_id, stored.scope, stored.resource, stored.username);
    const refreshToken = this._issueRefreshToken(client_id, stored.scope, stored.resource, stored.username);

    process.stderr.write(`[tqnn-oauth] Token issued for client ${client_id} (user: ${stored.username || 'n/a'})\n`);
    return {
      access_token:  accessToken,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope:         stored.scope
    };
  }

  _handleRefreshGrant(body) {
    const { refresh_token, client_id } = body;
    const stored = refreshTokens.get(refresh_token);
    if (!stored) {
      return { error: 'invalid_grant', error_description: 'Refresh token not found or expired' };
    }
    if (now() - stored.created_at > REFRESH_TOKEN_TTL) {
      refreshTokens.delete(refresh_token);
      return { error: 'invalid_grant', error_description: 'Refresh token expired' };
    }
    if (stored.client_id !== client_id) {
      return { error: 'invalid_client' };
    }
    // Live revocation check — reject refresh if the employee was disabled
    // since this refresh token was issued.
    if (stored.username && !isUserActive(stored.username)) {
      refreshTokens.delete(refresh_token);
      return { error: 'invalid_grant', error_description: 'User account disabled' };
    }

    // Rotate refresh token
    refreshTokens.delete(refresh_token);
    const newAccess  = this._issueAccessToken(client_id, stored.scope, stored.resource, stored.username);
    const newRefresh = this._issueRefreshToken(client_id, stored.scope, stored.resource, stored.username);
    return {
      access_token:  newAccess,
      token_type:    'Bearer',
      expires_in:    ACCESS_TOKEN_TTL,
      refresh_token: newRefresh,
      scope:         stored.scope
    };
  }

  // ── Token issuance ──────────────────────────────────────────────────────────
  _issueAccessToken(clientId, scope, resource, username) {
    const payload = { sub: clientId, scope, resource, iat: now(), exp: now() + ACCESS_TOKEN_TTL, jti: randomToken(16) };
    const token = this._signPayload(payload);
    accessTokens.set(token, { client_id: clientId, scope, resource, username, created_at: now() });
    return token;
  }

  _issueRefreshToken(clientId, scope, resource, username) {
    const token = randomToken(40);
    refreshTokens.set(token, { client_id: clientId, scope, resource, username, created_at: now() });
    return token;
  }

  _signPayload(payload) {
    const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body    = b64url(JSON.stringify(payload));
    const sig     = hmacSign(this.secret, `${header}.${body}`);
    return `${header}.${body}.${sig}`;
  }

  // ── Token validation (called per MCP request) ───────────────────────────────
  /**
   * Validate a Bearer token from Authorization header.
   *
   * Runs on EVERY MCP request (both /sse and /messages), so this is also
   * the immediate-revocation checkpoint: if the employee this token belongs
   * to has been disabled in tqnn_mcp_users.json since the token was issued,
   * the token is rejected here and then actively purged — no waiting for
   * expiry, no restart needed. Edits to tqnn_mcp_users.json take effect on
   * the very next request from that employee.
   *
   * @param {string} authHeader - Value of Authorization header
   * @returns {{ valid: boolean, client_id?: string, scope?: string, username?: string }}
   */
  validateToken(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { valid: false };
    }
    const token = authHeader.slice(7).trim();
    const stored = accessTokens.get(token);
    if (!stored) return { valid: false };
    if (now() - stored.created_at > ACCESS_TOKEN_TTL) {
      accessTokens.delete(token);
      return { valid: false };
    }
    // Verify HMAC signature
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return { valid: false };
      const expectedSig = hmacSign(this.secret, `${parts[0]}.${parts[1]}`);
      if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(parts[2]))) {
        return { valid: false };
      }
    } catch { return { valid: false }; }

    // Live revocation check — disabling a user in tqnn_mcp_users.json kills
    // this token immediately, even though the signature/expiry checks above
    // still pass. Skipped for legacy-mode tokens (no username attached).
    if (stored.username && !isUserActive(stored.username)) {
      accessTokens.delete(token);
      for (const [rtoken, rstored] of refreshTokens) {
        if (rstored.client_id === stored.client_id && rstored.username === stored.username) {
          refreshTokens.delete(rtoken);
        }
      }
      return { valid: false, reason: 'user_disabled' };
    }

    const client = clients.get(stored.client_id);
    return {
      valid:       true,
      client_id:   stored.client_id,
      client_name: client ? client.client_name : undefined,
      scope:       stored.scope,
      username:    stored.username,
    };
  }

  // ── Credential check ────────────────────────────────────────────────────────
  // Checks tqnn_mcp_users.json first (per-employee accounts). If that file
  // isn't present at all, falls back to the single legacy admin login from
  // .env — so this is a non-breaking change for anyone who hasn't set up
  // per-employee accounts yet.
  // Returns the authenticated username on success (for per-employee mode,
  // this is their own username; for legacy mode, this.adminUser), or null
  // on failure.
  _checkCredentials(username, password) {
    if (!username || !password) return null;

    const users = loadUsers();

    if (users) {
      const entry = users[username];
      if (!entry) return null;
      if (entry.status !== 'active') return null;
      if (!verifyPassword(password, entry.password_hash || '')) return null;
      return username;
    }

    // Legacy fallback — single shared admin login
    const passHash = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
    const userOk = crypto.timingSafeEqual(Buffer.from(this.adminUser.padEnd(64)), Buffer.from(username.padEnd(64)));
    const passOk = crypto.timingSafeEqual(Buffer.from(this.adminPassHash), Buffer.from(passHash));
    return (userOk && passOk) ? this.adminUser : null;
  }

  // ── HTML consent form ────────────────────────────────────────────────────────
  _renderAuthForm(state, clientName, scope, errorMsg) {
    const scopes = (scope || SCOPES_SUPPORTED.join(' ')).split(' ').filter(Boolean);
    const scopeList = scopes.map(s => `<li>${escHtml(s)}</li>`).join('');
    const err = errorMsg ? `<div class="error">${escHtml(errorMsg)}</div>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TQNN DMM — Authorise Access</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:2rem;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .logo{font-size:1.4rem;font-weight:700;color:#7c3aed;letter-spacing:.05em;margin-bottom:.25rem}
    .subtitle{color:#718096;font-size:.85rem;margin-bottom:1.5rem}
    h2{font-size:1.1rem;font-weight:600;margin-bottom:.5rem}
    .client{color:#a78bfa;font-weight:500}
    .scopes{background:#111827;border-radius:8px;padding:.75rem 1rem;margin:1rem 0}
    .scopes p{font-size:.8rem;color:#718096;margin-bottom:.4rem}
    .scopes ul{list-style:none;font-size:.85rem;color:#9ca3af}
    .scopes li::before{content:"✓ ";color:#7c3aed}
    .field{margin:.75rem 0}
    label{display:block;font-size:.8rem;color:#9ca3af;margin-bottom:.3rem}
    input{width:100%;padding:.6rem .75rem;background:#111827;border:1px solid #374151;border-radius:6px;color:#e2e8f0;font-size:.9rem;outline:none;transition:border-color .2s}
    input:focus{border-color:#7c3aed}
    .error{background:#2d1515;border:1px solid #7f1d1d;color:#fca5a5;border-radius:6px;padding:.6rem .75rem;font-size:.85rem;margin:.75rem 0}
    .actions{display:flex;gap:.75rem;margin-top:1.25rem}
    .btn{flex:1;padding:.65rem 1rem;border:none;border-radius:6px;font-size:.9rem;font-weight:600;cursor:pointer;transition:opacity .2s}
    .btn:hover{opacity:.85}
    .btn-primary{background:#7c3aed;color:#fff}
    .btn-secondary{background:#374151;color:#d1d5db}
    .footer{margin-top:1.5rem;font-size:.75rem;color:#4b5563;text-align:center}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">TQNN DMM</div>
  <div class="subtitle">Toridion Associative Memory</div>
  <h2>Authorise <span class="client">${escHtml(clientName || 'MCP Client')}</span></h2>
  <p style="font-size:.85rem;color:#718096;margin-top:.3rem">This application is requesting access to your DMM associative memory.</p>
  <div class="scopes">
    <p>Permissions requested:</p>
    <ul>${scopeList}</ul>
  </div>
  ${err}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="state" value="${escHtml(state)}">
    <div class="field">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>
    <div class="actions">
      <button class="btn btn-secondary" type="submit" name="action" value="deny">Deny</button>
      <button class="btn btn-primary" type="submit" name="action" value="approve">Approve</button>
    </div>
  </form>
  <div class="footer">TQNN MCP Server · Toridion Ltd</div>
</div>
</body>
</html>`;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  _cleanupExpired() {
    const n = now();
    for (const [k, v] of authCodes)    if (n - v.created_at > AUTH_CODE_TTL)     authCodes.delete(k);
    for (const [k, v] of accessTokens) if (n - v.created_at > ACCESS_TOKEN_TTL)  accessTokens.delete(k);
    for (const [k, v] of refreshTokens)if (n - v.created_at > REFRESH_TOKEN_TTL) refreshTokens.delete(k);
    for (const [k, v] of pendingAuths) if (n - v.created_at > AUTH_CODE_TTL * 2) pendingAuths.delete(k);
  }
}

// ── Body parser helper ─────────────────────────────────────────────────────────
/**
 * Read and parse a request body as JSON or URL-encoded form.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      try {
        if (ct === 'application/json') {
          resolve(JSON.parse(raw || '{}'));
        } else {
          // application/x-www-form-urlencoded (token endpoint, form submissions)
          const params = new URLSearchParams(raw);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          resolve(obj);
        }
      } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * Minimal HTML entity escaping for user-controlled values in HTML output.
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { OAuthServer, readBody, hashPassword, verifyPassword };
