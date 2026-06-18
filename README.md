# tqnn-mcp-server

MCP (Model Context Protocol) server that exposes the **TQNN DMM** associative memory API as callable tools for Claude and other MCP-compatible LLMs.

This makes DMM a **live memory layer inside the LLM context window** — Claude can call TQNN's associative retrieval during inference without DMM knowing anything about LLMs.

Licence: [MIT](https://opensource.org/licenses/MIT)

---

## Architecture

```
Claude (reasoning/generation)
        │  MCP tool calls
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

## Quick start

### 1. Install

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in your credentials:

```env
TQNN_BASE_URL=https://<yourdomain or url>   # or https://tqnn.local for local appliance
TQNN_API_KEY=your_api_key_here
TQNN_API_SECRET=your_api_secret_here
TQNN_DATASET=your_dataset_name           # e.g. lindisfarne-m1
```

Your API key and secret are available from your TQNN console (`/tqnn_console.html`).

---

### 2. Test DMM connectivity (no MCP involved)

Before touching Claude, confirm the server can reach your DMM appliance:

```bash
node test.js
```

Expected output: ping ✓, searchDoc ✓, similarity results ✓

If this fails, check your `TQNN_BASE_URL`, credentials, and network. Fix this before moving on.

---

### 3. Run in SSE mode

SSE mode starts an HTTP server that claude.ai can connect to via the MCP Integrations panel.

Add `MCP_MODE=sse` to your `.env` file:

```env
MCP_MODE=sse
```

#### Option A — Local machine (development)

**Terminal 1 — start the MCP server:**

```bash
node index.js
```

You should see:

```
[tqnn-mcp] Running in SSE mode on port 3100
[tqnn-mcp] SSE endpoint : http://localhost:3100/sse
[tqnn-mcp] Health check : http://localhost:3100/health
```

**Terminal 2 — expose it publicly with ngrok:**

```bash
ngrok http 3100
```

ngrok will print a forwarding URL like:

```
Forwarding  https://abc123.ngrok-free.app -> http://localhost:3100
```

Copy that HTTPS URL — you'll need it in step 5.

> **No ngrok account?** Sign up free at [ngrok.com](https://ngrok.com). The free tier is sufficient.

---

#### Option B — Remote server or Raspberry Pi (persistent deployment)

For a persistent deployment that survives SSH disconnects and reboots — such as running the MCP server on a Raspberry Pi 5 alongside the TQNN DMM appliance — use **pm2** as a process manager and **ngrok** for HTTPS tunnelling.

**Install pm2 and ngrok:**

```bash
sudo npm install -g pm2

# Install ngrok
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Authenticate ngrok (one time)
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

**Start ngrok in the background:**

```bash
nohup ngrok http 3100 > ~/ngrok.log 2>&1 &

# Get your public URL
curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | head -1
```

**Start the MCP server with pm2:**

```bash
cd ~/dmm-mcp-server
pm2 start index.js --name tqnn-mcp
pm2 save
```

**Register pm2 to start on boot** (copy and run the command pm2 prints):

```bash
pm2 startup
# Then run the sudo command it outputs, e.g.:
# sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u tqnn --hp /home/tqnn
```

**Verify everything is running:**

```bash
pm2 status
curl http://localhost:3100/health
curl https://abc123.ngrok-free.app/health
```

You can now safely close your SSH session — both ngrok and the MCP server will keep running.

**Useful pm2 commands:**

```bash
pm2 status              # show running processes
pm2 logs tqnn-mcp       # tail live logs
pm2 restart tqnn-mcp    # restart after config changes
pm2 stop tqnn-mcp       # stop the server
```

**Pulling updates from GitHub:**

```bash
cd ~/dmm-mcp-server
git pull
pm2 restart tqnn-mcp
```

---

### 4. Verify the MCP protocol (optional but recommended — local only)

With the server running in SSE mode, run the MCP protocol test suite:

```bash
node mcp-test.js
```

This spawns `index.js` in stdio mode and exercises the full MCP JSON-RPC handshake — `initialize`, `tools/list`, and tool calls for `tqnn_status`, `tqnn_search`, and `tqnn_similarity`. All five tests should pass before connecting to Claude.

> `test.js` tests raw DMM connectivity. `mcp-test.js` tests the MCP protocol layer on top. Run both if you're setting up for the first time.

---

### 5. Connect to claude.ai

1. Go to **claude.ai → Settings → Integrations**
2. Click **Add MCP Server**
3. Paste your ngrok HTTPS URL — append `/sse`:
   ```
   https://abc123.ngrok-free.app/sse
   ```
4. Save. Claude will handshake with the server and confirm the four tools are available.

You can verify the connection is live by hitting the health endpoint in a browser:

```
https://abc123.ngrok-free.app/health
```

---

### 6. Query DMM through Claude

Start a new conversation in claude.ai. Claude will automatically have access to the TQNN tools. Try:

```
Use tqnn_status to confirm you can reach the DMM appliance, then search for "diabetes mellitus" using tqnn_similarity and tell me what you find.
```

Claude will call `tqnn_status`, then `tqnn_similarity`, and reason over the ranked filereferences returned by your DMM.

---

## Claude Code integration (stdio)

For local development with Claude Code, use stdio mode instead of SSE. Add to `~/.claude/settings.json`:

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
        "TQNN_DATASET": "lindisfarne-m1",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "MCP_MODE": "stdio"
      }
    }
  }
}
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `TQNN_BASE_URL` | `https://tqnn.local` | DMM appliance URL |
| `TQNN_API_KEY` | *(required)* | DMM API key |
| `TQNN_API_SECRET` | *(required)* | DMM API secret |
| `TQNN_DATASET` | *(empty)* | Default dataset/namespace |
| `NODE_TLS_REJECT_UNAUTHORIZED` | *(unset)* | Set `0` for tqnn.local self-signed cert |
| `MCP_MODE` | `stdio` | `stdio` or `sse` |
| `MCP_PORT` | `3100` | HTTP port (SSE mode only) |

---

## Implementation notes

- **PQR hash** — `searchDoc` pattern must be `SHA-256(pad_to_16_chars(token))`. Raw text will not work.
- **FPD** — False Positive Defence: two `searchDoc` calls per token (forward + reversed input string), AND the result sets. Only filereferences in both are genuine.
- **Filelist** — DMM returns filelist as newline-delimited string, not JSON array.
- **Timestamps** — DMM appends `::unix_timestamp` to filereferences. Stripped for comparison; preserved in output.
- **TLS** — `NODE_TLS_REJECT_UNAUTHORIZED=0` for tqnn.local only. Remove for https<yourdomain or url> (valid cert).
- **Node 18+** — uses built-in `FormData` and `fetch`. No extra HTTP packages required.

---

## ⚠️ Security notice — demo configuration

This server is configured for getting-started simplicity. The defaults are appropriate for a local or ngrok-tunnelled demo session. Before deploying beyond that, be aware of the following.

 - **Add MCP server authentication** — no bearer token is required by default;
   anyone who can reach the SSE endpoint can invoke all tools including `tqnn_store`.
 - **Restrict CORS** — set `CORS_ORIGIN=https://claude.ai` in production.
 - **Remove `NODE_TLS_REJECT_UNAUTHORIZED=0`** when using a public HTTPS DMM endpoint.
 - **Add request body size limits** and rate limiting before exposing to untrusted clients.
 - The `.env` parser does not handle values containing `=` signs correctly — use
   `npm install dotenv` for production secrets management.

---

## About TQNN DMM

TQNN DMM is a deterministic, write-time-encoded associative memory architecture operating in high-dimensional semantic space. It achieves O(1) content-addressable retrieval without index structures. Architecturally aligned with Kanerva's Sparse Distributed Memory and VSA tradition.

**It is not a vector database.** It does not use embeddings or cosine similarity. Retrieval is associative: multiple associations may occupy shared high-dimensional space and resolve differently depending on retrieval cue — a superposition property consistent with Kanerva SDM and biological episodic memory.

More: [toridion.com](https://toridion.com) | Dataset: [Toridion/lindisfarne-m1](https://huggingface.co/datasets/Toridion/lindisfarne-m1)
