# OAuth 2.1 Upgrade Guide — tqnn-mcp-server v1.1.0

## What changed

v1.1.0 adds a self-contained OAuth 2.1 authorization server to the SSE mode HTTP
server. Two new files: `oauth.js` (auth logic) and an updated `index.js`. No new npm
packages — everything uses Node 18+ built-ins (`crypto`, `http`, `URL`).

**stdio mode is unchanged.** Claude Code users: nothing to do.

---

## Why this was needed

claude.ai's remote MCP connector follows the MCP authorization spec
(2025-06-18). When it connects to a remote SSE server it:

1. Sends an unauthenticated request and expects `401 + WWW-Authenticate`.
2. Fetches `/.well-known/oauth-protected-resource` to find your authorization server.
3. Fetches `/.well-known/oauth-authorization-server` for AS metadata.
4. Registers itself via `POST /oauth/register` (Dynamic Client Registration).
5. Redirects you (the user) to `GET /oauth/authorize` — you log in on a consent page.
6. Exchanges the authorization code for a Bearer token via `POST /oauth/token`.
7. Sends all subsequent MCP requests with `Authorization: Bearer <token>`.

The server now implements all of these endpoints.

---

## Pi5 upgrade steps

### 1. Pull the new files

```bash
cd ~/dmm-mcp-server
git pull
```

Or copy `index.js` and `oauth.js` manually if you're not on the repo.

### 2. Generate a token-signing secret

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Copy the output. This is your `TQNN_MCP_SECRET`. Keep it safe — regenerating it
invalidates all existing tokens.

### 3. Update .env

Add these four new variables to your `.env`:

```env
# The public HTTPS URL of this server.
# On a free ngrok plan this changes on each restart — update it here each time.
TQNN_PUBLIC_URL=https://sprint-umpire-wrongdoer.ngrok-free.dev

# Token signing secret (from step 2).
TQNN_MCP_SECRET=<paste generated secret here>

# OAuth consent page credentials — what you'll log in with in the browser.
TQNN_OAUTH_USER=admin
TQNN_OAUTH_PASS=<strong password>
```

Full `.env.example` is in the repo.

### 4. Restart the server

```bash
pm2 restart tqnn-mcp
pm2 logs tqnn-mcp --lines 20
```

You should see:
```
[tqnn-mcp] Running in SSE mode on port 3100
[tqnn-mcp] Public URL   : https://sprint-umpire-wrongdoer.ngrok-free.dev
[tqnn-mcp] OAuth AS     : https://sprint-umpire-wrongdoer.ngrok-free.dev/.well-known/oauth-authorization-server
```

If you see `ERROR: TQNN_MCP_SECRET must be set` or `ERROR: TQNN_OAUTH_PASS must be set`,
the server has exited — check your `.env`.

### 5. Verify the OAuth discovery endpoints

```bash
curl https://sprint-umpire-wrongdoer.ngrok-free.dev/.well-known/oauth-protected-resource | jq
curl https://sprint-umpire-wrongdoer.ngrok-free.dev/.well-known/oauth-authorization-server | jq
```

Both should return JSON. The first should have `"resource"` matching your ngrok URL
exactly. The second should list `authorization_endpoint`, `token_endpoint`,
`registration_endpoint`, and `"code_challenge_methods_supported": ["S256"]`.

### 6. Connect in claude.ai

1. Go to **claude.ai → Settings → Integrations → Add MCP Server**.
2. Paste your SSE URL:
   ```
   https://sprint-umpire-wrongdoer.ngrok-free.dev/sse
   ```
3. Save. Claude will begin the OAuth flow automatically.
4. A browser window opens to your consent page at `/oauth/authorize`.
   - Log in with `TQNN_OAUTH_USER` / `TQNN_OAUTH_PASS`.
   - Click **Approve**.
5. You'll be redirected back to claude.ai. The connector shows **Connected**.

---

## Ngrok free-plan note — fixed domain workaround

On a free ngrok plan the tunnel URL changes on every restart. When it changes:

1. Update `TQNN_PUBLIC_URL` in `.env`.
2. `pm2 restart tqnn-mcp`.
3. Remove and re-add the connector in claude.ai (the old URL is dead).

On a paid ngrok plan you can reserve a fixed subdomain:

```bash
ngrok http 3100 --domain=your-fixed-name.ngrok-free.app
```

Set that as `TQNN_PUBLIC_URL` permanently and you only configure claude.ai once.

---

## How it works — flow summary

```
claude.ai                         tqnn-mcp-server (Pi5)
─────────                         ──────────────────────
GET /sse  ────────────────────►  401 + WWW-Authenticate: Bearer resource_metadata=…
GET /.well-known/oauth-protected-resource  ◄────────────  { resource, authorization_servers }
GET /.well-known/oauth-authorization-server ◄───────────  { authorization_endpoint, token_endpoint, … }
POST /oauth/register  ────────►  { client_id, client_secret }
GET /oauth/authorize  ────────►  HTML consent form
  ↕ (user logs in in browser)
POST /oauth/authorize ────────►  302 → claude.ai/api/mcp/auth_callback?code=…
POST /oauth/token     ────────►  { access_token, refresh_token, … }
GET /sse (Authorization: Bearer <token>)  ────────────►  SSE stream open
POST /messages (Authorization: Bearer <token>)  ──────►  MCP tool responses
```

Token lifetime: 1 hour access / 30 days refresh (rotated on each refresh). All state
is in-memory — a Pi5 reboot means users re-authenticate (one click in claude.ai).

---

## Security notes

- `TQNN_OAUTH_PASS` is SHA-256 hashed immediately on startup; it never lives in memory
  as plaintext after the `OAuthServer` constructor returns.
- Token signing uses HMAC-SHA256 with `TQNN_MCP_SECRET`. All comparisons are
  constant-time (`crypto.timingSafeEqual`).
- PKCE S256 is enforced. Pure `client_credentials` grants (machine-to-machine with
  no user consent) are not supported — by design and by the MCP auth spec.
- In production set `CORS_ORIGIN=https://claude.ai` in `.env`.
- Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` if your DMM is on a public HTTPS endpoint.
- All state is in-memory. On restart, existing tokens are invalidated and users
  must re-authorise. For a Pi5 running 24/7 this is rarely an issue.

---

## Troubleshooting

**"Couldn't reach the MCP server"**
- Verify ngrok is running: `curl https://<ngrok-url>/health`
- Check `TQNN_PUBLIC_URL` matches the ngrok URL exactly (no trailing slash).
- Verify both `.well-known` endpoints return JSON (step 5 above).

**Consent page shows "Invalid credentials"**
- Check `TQNN_OAUTH_USER` and `TQNN_OAUTH_PASS` in `.env` match what you're typing.
- `pm2 restart tqnn-mcp` after any `.env` change.

**"Session not found" after approving**
- The SSE session expired or the server restarted between authorization and the
  first tool call. Reconnect the integration in claude.ai.

**Tokens stop working after restart**
- Expected — `TQNN_MCP_SECRET` is consistent across restarts so token *signatures*
  validate, but the in-memory `accessTokens` map is cleared. Users re-authenticate.
  If you want persistence across restarts, set a fixed `TQNN_MCP_SECRET` and the
  token signatures will still verify; only the server-side record is lost. A simple
  fix is to write tokens to a JSON file — raise an issue if this matters for your use case.

**pm2 logs show "TQNN_MCP_SECRET must be set"**
- The server exited on startup. Your `.env` is missing `TQNN_MCP_SECRET` or it's
  shorter than 32 characters.
