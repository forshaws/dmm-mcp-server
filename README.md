# tqnn-mcp-server

MCP (Model Context Protocol) server that exposes the **TQNN DMM** associative memory API as callable tools for Claude and other MCP-compatible LLMs.

This makes DMM a **live memory layer inside the LLM context window** — Claude can call TQNN's associative retrieval during inference without DMM knowing anything about LLMs.

Licence: [CC-BY-NC-4.0](https://creativecommons.org/licenses/by-nc/4.0/)

---

## Architecture

```
Claude (reasoning/generation)
        │  MCP tool calls  [OAuth 2.1 Bearer token]
        ▼
tqnn-mcp-server  ◄──── similarity orchestration, tokenisation, FPD, threshold
        │  multipart/form-data HTTP
        ▼
TQNN DMM appliance  ◄──── pure associative memory primitive (searchDoc / storeDoc)
```

DMM only ever sees individual `searchDoc` calls with PQR-hashed tokens. All higher-level intelligence (tokenisation, overlap scoring, FPD, similarity ranking) lives in this server.

---

## Tools exposed

| Tool | Description |
|---|---|
| `tqnn_status` | Ping DMM — confirm connectivity at session start |
| `tqnn_search` | Single `searchDoc` call — fast exact associative match |
| `tqnn_similarity` | Multi-call similarity orchestration — free text → ranked results |
| `tqnn_store` | `storeDoc` wrapper — Claude can write associations into DMM |

---

## Modes

| Mode | Use case | Auth |
|---|---|---|
| `stdio` | Claude Code, local development | None — credentials from environment |
| `sse` | claude.ai remote connector, production | OAuth 2.1 required |

---

## Quick start

### 1. Install

```bash
npm install
cp .env.example .env
```

Edit `.env` and fill in your credentials — see the [Configuration](#configuration) section for all variables.

---

### 2. Test DMM connectivity

Before involving Claude at all, confirm the server can reach your DMM appliance:

```bash
node test.js
```

Expected: ping ✓, searchDoc ✓, similarity results ✓

Fix any failures here before moving on — check `TQNN_BASE_URL`, credentials, and network.

---

### 3. Choose your deployment

#### Option A — Claude Code (stdio, local)

No auth required. Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "tqnn-dmm": {
      "command": "node",
      "args": ["/absolute/path/to/tqnn-mcp-server/index.js"],
      "env": {
        "TQNN_BASE_URL": "https://tqnn.local",
        "TQNN_API_KEY": "your_key",
        "TQNN_API_SECRET": "your_secret",
        "TQNN_DATASET": "your_dataset",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "MCP_MODE": "stdio"
      }
    }
  }
}
```

That's it — Claude Code picks it up automatically.

---

#### Option B — claude.ai remote connector (SSE + OAuth 2.1)

This is the production path. The server runs in SSE mode behind ngrok, with a
self-contained OAuth 2.1 authorization server handling authentication.

**How the OAuth flow works:**

```
claude.ai                           tqnn-mcp-server (Pi5 / server)
─────────                           ───────────────────────────────
GET /sse  ──────────────────────►  401 + WWW-Authenticate: Bearer resource_metadata=…
GET /.well-known/oauth-protected-resource  ◄──  { resource, authorization_servers }
GET /.well-known/oauth-authorization-server ◄──  { authorization_endpoint, token_endpoint, … }
POST /oauth/register  ──────────►  { client_id, client_secret }  [auto, no user action]
GET /oauth/authorize  ──────────►  HTML consent form
  ↕  you log in in your browser
POST /oauth/authorize ──────────►  302 → claude.ai/api/mcp/auth_callback?code=…
POST /oauth/token     ──────────►  { access_token, refresh_token, … }
GET /sse (Authorization: Bearer …)  ──────────────────────────►  SSE stream open
POST /messages (Authorization: Bearer …)  ────────────────────►  MCP tool responses
```

Token lifetime: 1 hour access / 30 days refresh (rotated on each use). All state is
in-memory — a server reboot means users re-authenticate with one click in claude.ai.

---

**Step 1 — Prepare your .env**

Ensure `MCP_MODE=sse` is set, then add the four OAuth variables:

```env
MCP_MODE=sse

# Public HTTPS URL of this server (your ngrok URL).
# Update this whenever ngrok restarts on a free plan.
TQNN_PUBLIC_URL=https://your-ngrok-url.ngrok-free.app

# HMAC secret for signing access tokens. Generate once, keep fixed.
# Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
TQNN_MCP_SECRET=your_generated_secret_min_32_chars

# Credentials for the OAuth consent page (what you log in with in the browser).
TQNN_OAUTH_USER=admin
TQNN_OAUTH_PASS=your_strong_password
```

The server hard-exits on startup if `TQNN_MCP_SECRET` or `TQNN_OAUTH_PASS` are missing.

---

**Step 2 — Start the server**

*Local machine (dev):*

```bash
# Terminal 1
node index.js

# Terminal 2 — expose publicly
ngrok http 3100
```

*Raspberry Pi 5 or remote server (production):*

```bash
# Start ngrok in the background
nohup ngrok http 3100 > ~/ngrok.log 2>&1 &
curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | head -1
# → copy that URL into TQNN_PUBLIC_URL in .env

# Start with pm2
cd ~/dmm-mcp-server
pm2 start index.js --name tqnn-mcp
pm2 save
pm2 startup   # follow the printed sudo command to survive reboots
```

---

**Step 3 — Verify OAuth discovery**

```bash
curl https://your-ngrok-url.ngrok-free.app/.well-known/oauth-authorization-server
```

You should see a JSON document containing `authorization_endpoint`, `token_endpoint`,
`registration_endpoint`, and `"code_challenge_methods_supported": ["S256"]`.

Also check the health endpoint:

```bash
curl https://your-ngrok-url.ngrok-free.app/health
```

---

**Step 4 — Connect claude.ai**

1. Go to **claude.ai → Settings → Integrations → Add MCP Server**
2. Paste your SSE URL:
   ```
   https://your-ngrok-url.ngrok-free.app/sse
   ```
3. Leave the OAuth Client ID / Client Secret fields **blank** — claude.ai registers
   itself automatically via Dynamic Client Registration.
4. Save. A browser tab opens to your consent page.
5. Log in with `TQNN_OAUTH_USER` / `TQNN_OAUTH_PASS` and click **Approve**.
6. You'll be redirected back to claude.ai. The connector shows **Connected**.

---

**Step 5 — Test it**

Start a new conversation in claude.ai, enable the TQNN connector, and try:

```
Use tqnn_status to confirm you can reach the DMM appliance, then search for
"diabetes mellitus" using tqnn_similarity and tell me what you find.
```

---

### 4. Verify the MCP protocol layer (optional)

This test spawns the server in stdio mode and exercises the full MCP JSON-RPC
handshake — `initialize`, `tools/list`, and tool calls for all three read tools.
Run it before connecting to Claude if you're setting up for the first time.

```bash
node mcp-test.js
```

All five tests should pass. `test.js` tests raw DMM connectivity; `mcp-test.js`
tests the MCP protocol layer on top.

---

## Ngrok free-plan note

On a free ngrok plan the tunnel URL changes on every restart. When it changes:

1. Update `TQNN_PUBLIC_URL` in `.env`
2. `pm2 restart tqnn-mcp`
3. Remove and re-add the connector in claude.ai

On a paid plan you can reserve a fixed domain:

```bash
ngrok http 3100 --domain=your-fixed-name.ngrok-free.app
```

Set that as `TQNN_PUBLIC_URL` permanently and you configure claude.ai once only.

---

## Useful pm2 commands

```bash
pm2 status                    # show running processes
pm2 logs tqnn-mcp             # tail live logs
pm2 logs tqnn-mcp --lines 50  # last 50 lines
pm2 restart tqnn-mcp          # restart after .env or code changes
pm2 stop tqnn-mcp             # stop the server
```

**Pulling updates from GitHub:**

```bash
cd ~/dmm-mcp-server
git pull
pm2 restart tqnn-mcp
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TQNN_BASE_URL` | `https://tqnn.local` | DMM appliance URL |
| `TQNN_API_KEY` | *(required)* | DMM API key |
| `TQNN_API_SECRET` | *(required)* | DMM API secret |
| `TQNN_DATASET` | *(empty)* | Default dataset/namespace |
| `NODE_TLS_REJECT_UNAUTHORIZED` | *(unset)* | Set `0` for tqnn.local self-signed cert only |
| `MCP_MODE` | `stdio` | `stdio` or `sse` |
| `MCP_PORT` | `3100` | HTTP port (SSE mode only) |
| `TQNN_PUBLIC_URL` | *(required in SSE mode)* | Public HTTPS URL of this server |
| `TQNN_MCP_SECRET` | *(required in SSE mode)* | HMAC secret for token signing (≥32 chars) |
| `TQNN_OAUTH_USER` | `admin` | Username for the OAuth consent page |
| `TQNN_OAUTH_PASS` | *(required in SSE mode)* | Password for the OAuth consent page |
| `CORS_ORIGIN` | `*` | Restrict to `https://claude.ai` in production |

---

## Implementation notes

- **PQR hash** — `searchDoc` pattern must be `SHA-256(pad_to_16_chars(token))`. Raw text will not work.
- **FPD** — False Positive Defence: two `searchDoc` calls per token (forward + reversed input string), AND the result sets. Only filereferences in both are genuine.
- **Filelist** — DMM returns filelist as newline-delimited string, not JSON array.
- **Timestamps** — DMM appends `::unix_timestamp` to filereferences. Stripped for comparison; preserved in output.
- **TLS** — `NODE_TLS_REJECT_UNAUTHORIZED=0` for tqnn.local only. Remove for any public HTTPS DMM endpoint with a valid cert.
- **Node 18+** — uses built-in `FormData`, `fetch`, and `crypto`. No extra HTTP packages required.
- **OAuth tokens** — HMAC-SHA256 signed, 1-hour lifetime, constant-time validation. Refresh tokens rotate on use (30-day lifetime). All state in-memory.

---

## Security

- OAuth 2.1 with PKCE (S256) is enforced on all SSE endpoints. Unauthenticated requests receive `401 + WWW-Authenticate`.
- `TQNN_OAUTH_PASS` is SHA-256 hashed immediately on startup and never held in memory as plaintext.
- Token comparisons use `crypto.timingSafeEqual` throughout.
- Dynamic Client Registration is open (no pre-shared secret required) — consistent with the MCP spec and how claude.ai connects. `tqnn_store` is still protected behind OAuth.
- Set `CORS_ORIGIN=https://claude.ai` in `.env` for production deployments.
- Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` if your DMM appliance uses a properly signed certificate.

---

## Troubleshooting

**"Couldn't reach the MCP server"**
- Verify ngrok is running: `curl https://<ngrok-url>/health`
- Check `TQNN_PUBLIC_URL` in `.env` matches the ngrok URL exactly (no trailing slash).
- Check both `.well-known` endpoints return JSON.

**Claude asks for OAuth Client ID / Client Secret**
- Leave both fields blank. Claude registers itself automatically.

**Consent page shows "Invalid credentials"**
- Check `TQNN_OAUTH_USER` and `TQNN_OAUTH_PASS` in `.env`.
- `pm2 restart tqnn-mcp` after any `.env` change.

**"Session not found" after approving**
- The server restarted between authorization and the first tool call. Reconnect the integration in claude.ai.

**pm2 logs show "TQNN_MCP_SECRET must be set"**
- The server exited on startup. Add `TQNN_MCP_SECRET` to `.env` (≥32 chars) and restart.

**Tokens stop working after a reboot**
- Expected. In-memory state is cleared on restart. Re-authenticate in claude.ai (one click — claude.ai will prompt automatically).

---

## About TQNN DMM

TQNN DMM is a deterministic, write-time-encoded associative memory architecture operating in high-dimensional semantic space. It achieves O(1) content-addressable retrieval without index structures. Architecturally aligned with Kanerva's Sparse Distributed Memory and VSA tradition.

**It is not a vector database.** It does not use embeddings or cosine similarity. Retrieval is associative: multiple associations may occupy shared high-dimensional space and resolve differently depending on retrieval cue — a superposition property consistent with Kanerva SDM and biological episodic memory.

More: [toridion.com](https://toridion.com) | Dataset: [Toridion/lindisfarne-m1](https://huggingface.co/datasets/Toridion/lindisfarne-m1)
