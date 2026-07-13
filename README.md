# tqnn-mcp-server

MCP (Model Context Protocol) server that exposes the **TQNN DMM** associative memory API as callable tools for Claude and other MCP-compatible LLMs..

This makes DMM a **live memory layer inside the LLM context window** — Claude can call TQNN's associative retrieval during inference without DMM knowing anything about LLMs.

Licence: [MIT](https://opensource.org/licenses/MIT)

---

## Architecture

```
Claude (reasoning/generation)
        │  MCP tool calls  [OAuth 2.1 Bearer token]
        ▼
tqnn-mcp-server  ◄──── similarity orchestration, tokenisation, FPD, threshold,
        │               per-employee auth + DMM credential routing
        │  multipart/form-data HTTP
        ▼
TQNN DMM appliance  ◄──── pure associative memory primitive (searchDoc / storeDoc),
                           dataset ACL enforcement (tqnn_acl_gate())
```

DMM only ever sees individual `searchDoc` calls with PQR-hashed tokens. All higher-level intelligence (tokenisation, overlap scoring, FPD, similarity ranking, employee auth, credential routing) lives in this server. **Dataset-level access control itself is enforced at the appliance**, not here — see [Authentication & per-employee access](#authentication--per-employee-access) for exactly where the line sits.

---

## Tools exposed

| Tool | Description |
|---|---|
| `tqnn_status` | Ping DMM — confirm connectivity at session start |
| `tqnn_search` | Single `searchDoc` call — fast exact associative match. Query is always PQR-hashed before sending. |
| `tqnn_similarity` | Multi-call similarity orchestration — free text → ranked results, IDF-weighted token scoring, optional FPD |
| `tqnn_store` | `storeDoc` wrapper — Claude can write associations into DMM. Supports independent `pqr` and `fpd` toggles per call. |
| `tqnn_get` | Resolver — retrieve content for any filereference via ping / info / fetch. See [docs/resolvers.md](docs/resolvers.md) |

> **Note:** `tqnn_search` and `tqnn_similarity` do not currently expose a `pqr` opt-out the way `tqnn_store` does — both tools always PQR-hash the query before sending. A matching `pqr` boolean for the two search-side tools (to support plaintext/legacy-hash datasets without a wrapper) is planned but not yet implemented.

---

## Modes

| Mode | Use case | Auth |
|---|---|---|
| `stdio` | Claude Code, local development | None — credentials from environment |
| `sse` | claude.ai remote connector, production | OAuth 2.1 required, optionally per-employee (see below) |

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

That's it — Claude Code picks it up automatically. Per-employee accounts (below) don't apply in stdio mode — there's no OAuth handshake to attach a username to, so the server always uses the static `.env` credential pair here.

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

The consent form checks credentials against `tqnn_mcp_users.json` if present (per-employee accounts), falling back to the single `TQNN_OAUTH_USER`/`TQNN_OAUTH_PASS` admin login if it isn't. See [Authentication & per-employee access](#authentication--per-employee-access) below.

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

# Credentials for the OAuth consent page (fallback admin login — see
# Authentication & per-employee access below for the per-employee path).
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
5. Log in with your employee account (or `TQNN_OAUTH_USER` / `TQNN_OAUTH_PASS` if you haven't set up per-employee accounts yet) and click **Approve**.
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

There's also a standalone resolver-layer test that needs neither a DMM connection nor the MCP stack — useful when you've just edited `tqnn_resolvers.json` (e.g. adding a new scheme) and want to confirm it parses and routes correctly before wiring it up end to end:

```bash
node resolver-test.js
```

Covers config loading, `normaliseRef` timestamp-stripping, `NO_RESOLVER` on an unknown scheme, and all built-in handlers (`memory`, `local_jsonl`, `url`, `webhook`/`cold_storage`) plus `NOT_FOUND` edge cases, using synthetic data. It does not exercise `local_blob`/`local_lba` directly (those need a live `storage_target.py`), but it will confirm any new scheme entry — like `sn655_pool_` — is at least syntactically wired up correctly.

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

Remember: `tqnn_resolvers.json`, `tqnn_mcp_users.json`, and `tqnn_mcp_credentials.json` are all cached in-process (by mtime for the latter two, at startup for the resolver config) — edits to any of them need a restart (or, for the two per-employee JSON files, take effect on the very next request with no restart at all — see below).

---

## Authentication & per-employee access

Two independent, file-based layers sit on top of the OAuth 2.1 flow described above. Both are optional — if their config files are absent, the server behaves exactly as a fresh install always has (single shared admin login, static `.env` DMM credentials). Nothing breaks if you never touch this section.

### Per-employee login (`tqnn_mcp_users.json`)

When this file is present, it replaces the single shared `TQNN_OAUTH_USER`/`TQNN_OAUTH_PASS` admin login with individual employee accounts:

```json
{
  "users": {
    "example_user": {
      "label": "Example User — replace or remove this entry",
      "password_hash": "REPLACE_WITH_OUTPUT_OF_tqnn_mcp_hash_password.js",
      "status": "active"
    }
  }
}
```

- Generate a `password_hash` with:
  ```bash
  node tqnn_mcp_hash_password.js "the employee's password"
  ```
  (scrypt, random salt each run — re-running for the same password produces a different-looking hash and that's expected; either is valid.)
- **Live revocation.** `status` is checked at the OAuth consent screen *and* on every subsequent MCP request — not just at login. Set an employee's status to `"disabled"` and their access is revoked on their very next request, including if they're holding an unexpired access token. No restart needed.
- If `tqnn_mcp_users.json` is missing entirely, the server falls back to the legacy single-admin login from `.env` — a non-breaking change for anyone who hasn't set up per-employee accounts.

### Per-employee DMM credentials (`tqnn_mcp_credentials.json`)

Separately, this file maps each authenticated employee (by username, matching the entry above) to their own DMM sub-credential pair:

```json
{
  "default": {
    "sub_apikey": "REPLACE_WITH_SUB_APIKEY_FROM_ACL_CONSOLE",
    "sub_apisecret": "REPLACE_WITH_SUB_APISECRET_FROM_ACL_CONSOLE",
    "dataset": "REPLACE_WITH_ONE_OF_THIS_CREDENTIALS_PERMITTED_DATASETS"
  },
  "users": {
    "example_user": {
      "sub_apikey": "REPLACE_WITH_SUB_APIKEY_FROM_ACL_CONSOLE",
      "sub_apisecret": "REPLACE_WITH_SUB_APISECRET_FROM_ACL_CONSOLE",
      "dataset": "REPLACE_WITH_ONE_OF_THIS_CREDENTIALS_PERMITTED_DATASETS"
    }
  }
}
```

**Important — where enforcement actually happens:** the sub-credential pairs referenced here are generated on the DMM appliance itself, via its ACL console (`tqnn_acl_manager.php`'s "generate" action) — not invented by this server. This file's only job is picking *which* credential pair to send for a given authenticated employee; the actual dataset whitelist enforcement happens appliance-side, in `esec.php`'s `tqnn_acl_gate()`. This server never duplicates or re-implements that access-control logic — it's purely a routing layer on top of it.

- The optional per-user `dataset` field sets that credential's *default* dataset for calls that don't explicitly specify one (`tqnn_status`/ping being the main case) — it must be one of the datasets that sub-credential is actually whitelisted for on the appliance, or the ping will 403.
- Resolution order: authenticated username → matching entry in `users` → else `default` entry → else the static `.env` `TQNN_API_KEY`/`TQNN_API_SECRET` pair. So an employee with no specific entry, and a `default` block with placeholder values, still functions — it just uses the server's own static credentials, same as before this feature existed.
- Employees authenticate once per OAuth session; every tool call on that connection reuses the same resolved DMM client (cached by credential pair), so credential resolution isn't repeated per tool call.
- stdio mode (Claude Code) has no OAuth username to look up, so it always uses the static `.env` pair regardless of what's in this file.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TQNN_BASE_URL` | `https://tqnn.local` | DMM appliance URL |
| `TQNN_API_KEY` | *(required)* | DMM API key — also the fallback used when per-employee credentials aren't configured |
| `TQNN_API_SECRET` | *(required)* | DMM API secret — see above |
| `TQNN_DATASET` | *(empty)* | Default dataset/namespace |
| `NODE_TLS_REJECT_UNAUTHORIZED` | *(unset)* | Set `0` for tqnn.local self-signed cert only |
| `MCP_MODE` | `stdio` | `stdio` or `sse` |
| `MCP_PORT` | `3100` | HTTP port (SSE mode only) |
| `TQNN_PUBLIC_URL` | *(required in SSE mode)* | Public HTTPS URL of this server |
| `TQNN_MCP_SECRET` | *(required in SSE mode)* | HMAC secret for token signing (≥32 chars) |
| `TQNN_OAUTH_USER` | `admin` | Username for the OAuth consent page — legacy/fallback login, superseded per-user by `tqnn_mcp_users.json` when present |
| `TQNN_OAUTH_PASS` | *(required in SSE mode)* | Password for the OAuth consent page — same fallback scope as above |
| `CORS_ORIGIN` | `*` | Restrict to `https://claude.ai` in production |

Per-employee login and DMM credential routing (`tqnn_mcp_users.json`, `tqnn_mcp_credentials.json`) are file-based, not env-configured — see [Authentication & per-employee access](#authentication--per-employee-access) above.

---

## Documentation

| Doc | Description |
|---|---|
| [docs/resolvers.md](docs/resolvers.md) | `tqnn_get` resolver system — logical namespaces, handler types, migration, custom handlers |

---

## Implementation notes

- **PQR hash (self-salting, V1.3.0+)** — `searchDoc`/`storeDoc` patterns are hashed with the self-salting scheme, not a static pad: `h1 = SHA-256(input)` → `mixed = input + h1` → `padded = mixed.slice(0, 16)` → `token = SHA-256(padded).slice(0, 16)`. The salt is derived from the input itself, so it defeats rainbow-table attacks without needing external key material or extra storage, and every input is lifted into the full 2²⁵⁶ hash space regardless of its own entropy. The old constant-padding scheme (padding short tokens with `*`) is superseded and kept in `similarity.js` only for reference/rollback — it's vulnerable to rainbow tables on low-entropy fields. **Any dataset still stored under the old scheme needs re-ingesting** before it will match self-salted search hashes.
- **FPD** — False Positive Defence: two `searchDoc` calls per token (forward + reversed input string), AND the result sets. Only filereferences in both are genuine.
- **Filelist** — DMM returns filelist as newline-delimited string, not JSON array.
- **Timestamps** — DMM appends a raw unix timestamp directly onto whatever filereference string it's given, with no separator of its own. This is why every filereference written to DMM should always end in `::` — that trailing `::` is what lets the timestamp be stripped cleanly back off on read (split on the *last* `::`, keep everything before it). One consequence worth knowing: if the original filereference had *only one* `::`-terminated segment at the very end (e.g. `pool::lba5::sectors1::`, no fpd suffix), the returned filereference after strip has **no trailing `::` at all** (`pool::lba5::sectors1`). If it had a `::`-delimited suffix after that (e.g. an `fpd_XXXXXXXX::` specialcode), one `::` survives in the middle. Either way: never write a custom resolver handler that requires a trailing `::` to parse correctly — split the string on `::` and match tokens by position instead. See [docs/resolvers.md](docs/resolvers.md) for the full explanation and both handlers (`local_blob`, `local_lba`) that already do this correctly.
- **TLS** — `NODE_TLS_REJECT_UNAUTHORIZED=0` for tqnn.local only. Remove for any public HTTPS DMM endpoint with a valid cert.
- **Node 18+** — uses built-in `FormData`, `fetch`, and `crypto`. No extra HTTP packages required.
- **OAuth tokens** — HMAC-SHA256 signed, 1-hour lifetime, constant-time validation. Refresh tokens rotate on use (30-day lifetime). All state in-memory. Token validation also carries a live per-employee revocation check (see [Authentication & per-employee access](#authentication--per-employee-access)) — this is in addition to, not instead of, signature/expiry checks.

---

## Security

- OAuth 2.1 with PKCE (S256) is enforced on all SSE endpoints. Unauthenticated requests receive `401 + WWW-Authenticate`.
- `TQNN_OAUTH_PASS` is SHA-256 hashed immediately on startup and never held in memory as plaintext. Per-employee passwords in `tqnn_mcp_users.json` use scrypt with a random salt per entry (`salt_hex:hash_hex`), verified in constant time.
- Token comparisons use `crypto.timingSafeEqual` throughout.
- Dynamic Client Registration is open (no pre-shared secret required) — consistent with the MCP spec and how claude.ai connects. `tqnn_store` is still protected behind OAuth.
- Set `CORS_ORIGIN=https://claude.ai` in `.env` for production deployments.
- Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` if your DMM appliance uses a properly signed certificate.
- `tqnn_mcp_credentials.json` and `tqnn_mcp_users.json` contain (or reference) credentials/secrets — treat them like `.env`, not like general-purpose config: don't commit real values, and restrict file permissions on the server the same way you would for `.env`.
- Dataset-level access control is enforced on the DMM appliance (`esec.php`'s `tqnn_acl_gate()`), not in this server — see [Authentication & per-employee access](#authentication--per-employee-access) for the exact division of responsibility.

---

## Troubleshooting

**"Couldn't reach the MCP server"**
- Verify ngrok is running: `curl https://<ngrok-url>/health`
- Check `TQNN_PUBLIC_URL` in `.env` matches the ngrok URL exactly (no trailing slash).
- Check both `.well-known` endpoints return JSON.

**Claude asks for OAuth Client ID / Client Secret**
- Leave both fields blank. Claude registers itself automatically.

**Consent page shows "Invalid credentials"**
- If using per-employee accounts: check the username exists in `tqnn_mcp_users.json`, `status` is `"active"`, and the password matches what `tqnn_mcp_hash_password.js` was run against.
- Otherwise: check `TQNN_OAUTH_USER` and `TQNN_OAUTH_PASS` in `.env`.
- `pm2 restart tqnn-mcp` after any `.env` change (edits to `tqnn_mcp_users.json`/`tqnn_mcp_credentials.json` do **not** need a restart — they're re-read on the next request).

**An employee's access won't revoke / they can still call tools after being disabled**
- Confirm their entry in `tqnn_mcp_users.json` has `"status": "disabled"` exactly (not `"inactive"` or removed entirely — a missing entry falls through to "no per-employee accounts configured" logic differently than an explicitly disabled one in edge cases, so prefer explicit disabling over deletion).
- This check is live on every request, so if access is still working, first confirm the file actually saved / the edit reached the server the process is running on.

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
