# tqnn_get Resolver System

The `tqnn_get` tool retrieves content for any filereference returned by `tqnn_search` or `tqnn_similarity`. TQNN DMM never stores file content — only associations. The resolver is the bridge between a DMM filereference and the actual data, wherever it lives.

---

## The core principle

A filereference in DMM is a **logical key**, not a physical path. When you ingest documents, you assign each one a filereference that begins with a developer-defined namespace prefix. The resolver maps that prefix to a storage location — and when storage moves, only the resolver config changes. The millions of filereferences in DMM stay untouched.

This is the same principle as DNS: the name is permanent, the address is configurable.

```
records_0002.jsonl::line5975::REC-00025975::   →   /home/tqnn/data/records_0002.jsonl (line 5975)
                                               →   s3://new-bucket/records_0002.jsonl (after migration)
                                               →   https://middleware.example.com/resolve (via webhook)
```

---

## Logical namespace prefixes

Filereferences that begin with `[a-zA-Z0-9]+_` (letters/numbers followed by an underscore) are **logical namespaces**. The resolver matches the prefix to an entry in `tqnn_resolvers.json`.

| Prefix | Example filereference |
|---|---|
| `records_` | `records_0002.jsonl::line5975::REC-00025975::` |
| `invoices_` | `invoices_2024::INV-00293::acme-corp::` |
| `contracts_` | `contracts_acme::CLT-00042::v3::` |
| `patients_` | `patients_NHS::7857655619::ruby-smith::` |

**Anything that does not match `[a-zA-Z0-9]+_` is a non-logical reference** — full URLs, Windows drive letters, UNC paths, mount points. These are routed to the `*` catch-all webhook entry, where developer middleware handles translation. DMM filereferences never need to change even when storage topology does.

---

## tqnn_resolvers.json

Drop this file in the `dmm-mcp-server` root directory alongside `index.js`. The server loads it on first tool call and caches it for the session. Changes require `pm2 restart tqnn-mcp`.

### Minimal example — all use cases

```json
{
  "resolvers": [

    {
      "_use_case": "Local JSONL dataset — e.g. Lindisfarne M1 ingested line by line",
      "_example_ref": "records_0002.jsonl::line5975::REC-00025975::",
      "scheme": "records_",
      "type": "local_jsonl",
      "handler": "local_jsonl",
      "config": {
        "base_path": "/home/tqnn/data/",
        "encoding": "utf8",
        "max_fetch_bytes": 5242880
      }
    },

    {
      "_use_case": "Documents in S3 — middleware handles auth, DMM never sees credentials",
      "_example_ref": "contracts_acme::CLT-00042::v3::",
      "scheme": "contracts_",
      "type": "s3_via_webhook",
      "handler": "webhook",
      "config": {
        "webhook_url": "ENV:RESOLVER_CONTRACTS_WEBHOOK_URL",
        "auth_header": "X-TQNN-Secret",
        "auth_value": "ENV:RESOLVER_WEBHOOK_SECRET"
      }
    },

    {
      "_use_case": "SharePoint / M365 — middleware uses MS Graph, identity from Azure AD",
      "_example_ref": "sharepoint_legal::DOC-00881::compliance-2024::",
      "scheme": "sharepoint_",
      "type": "m365_via_webhook",
      "handler": "webhook",
      "config": {
        "webhook_url": "ENV:RESOLVER_SHAREPOINT_WEBHOOK_URL",
        "auth_header": "X-TQNN-Secret",
        "auth_value": "ENV:RESOLVER_WEBHOOK_SECRET"
      }
    },

    {
      "_use_case": "Cold/archive storage — retrieval is async, returns a ticket",
      "_example_ref": "archive_2023::batch-003::REC-00041234::",
      "scheme": "archive_",
      "type": "cold_storage",
      "handler": "webhook",
      "config": {
        "webhook_url": "ENV:RESOLVER_ARCHIVE_WEBHOOK_URL",
        "auth_header": "X-TQNN-Secret",
        "auth_value": "ENV:RESOLVER_WEBHOOK_SECRET",
        "estimated_hours": 4
      }
    },

    {
      "_use_case": "In-memory namespace — written by tqnn_store, cleared on server restart",
      "_example_ref": "memory://claude/session/2026-06-25::",
      "scheme": "memory://",
      "type": "memory",
      "handler": "memory"
    },

    {
      "_use_case": "AWS Glacier — cold storage, async retrieval",
      "_example_ref": "glacier://archive/2024/Q1/batch-003::",
      "scheme": "glacier://",
      "type": "cold_storage",
      "handler": "webhook",
      "config": {
        "webhook_url": "ENV:RESOLVER_GLACIER_WEBHOOK_URL",
        "auth_header": "X-TQNN-Secret",
        "auth_value": "ENV:RESOLVER_WEBHOOK_SECRET",
        "estimated_hours": 4
      }
    },

    {
      "_use_case": "Catch-all for non-logical refs: https://, C:\\, \\\\server\\, /mnt/ etc.",
      "_behaviour": "Full filereference passed as-is to middleware. Middleware handles URL rewriting, drive mapping, SMB resolution, bucket migration. DMM filereferences never change.",
      "scheme": "*",
      "type": "passthrough",
      "handler": "webhook",
      "config": {
        "webhook_url": "ENV:RESOLVER_DEFAULT_WEBHOOK_URL",
        "auth_header": "X-TQNN-Secret",
        "auth_value": "ENV:RESOLVER_WEBHOOK_SECRET"
      }
    }

  ],

  "fetch_options": {
    "allow_zip": true,
    "zip_threshold_bytes": 102400,
    "max_inline_bytes": 1048576
  }
}
```

---

## Handler types

### `local_jsonl`

Reads from a local file on the same machine as the MCP server. Supports whole-file fetch and line extraction.

**Filereference format:**
```
records_0002.jsonl::line5975::REC-00025975::
│                   │         │
│                   │         └─ record ID (informational)
│                   └─ line hint — extracts this line if present
└─ filename — appended to base_path
```

**Config:**

| Key | Description |
|---|---|
| `base_path` | Absolute path to directory containing the data files |
| `encoding` | File encoding — usually `utf8` |
| `max_fetch_bytes` | Maximum file size for inline fetch (default 5MB) |

**Line extraction:** if the filereference contains `::lineN::`, the resolver extracts line N from the file (1-indexed). If no line hint is present, the whole file is returned.

**Migration:** when files move to a new directory or mount point, update `base_path` and restart. Filereferences in DMM do not change.

---

### `webhook`

Forwards the request to a developer-controlled HTTP endpoint. The resolver POSTs a JSON payload and returns whatever the endpoint responds with. This is the correct handler for S3, SharePoint, SMB shares, databases, or any storage the MCP server cannot access directly.

**Webhook request payload:**
```json
{
  "operation": "fetch",
  "filereference": "contracts_acme::CLT-00042::v3::",
  "resolver_type": "s3_via_webhook",
  "timestamp": "2026-06-25T16:00:00.000Z",
  "request_id": "a3f9c2e1b8d47f0c"
}
```

**Expected response (fetch):**
```json
{
  "status": "OK",
  "content_type": "application/json",
  "content": "{ ... file content ... }",
  "encoding": "utf8"
}
```

**Expected response (ping):**
```json
{ "status": "AVAILABLE" }
```

**Expected response (cold storage fetch — initiates retrieval):**
```json
{
  "status": "RETRIEVAL_PENDING",
  "ticket_id": "RTK-00293847",
  "estimated_hours": 4,
  "message": "Retrieval initiated."
}
```

**Config:**

| Key | Description |
|---|---|
| `webhook_url` | Full URL of your middleware endpoint. Use `ENV:VAR_NAME` to read from environment. |
| `auth_header` | Header name for authentication (default `X-TQNN-Secret`) |
| `auth_value` | Header value. Use `ENV:VAR_NAME` to read from environment. |
| `estimated_hours` | For cold storage — returned in ping/info responses |

---

### `memory`

Handles `memory://` filereferences written by `tqnn_store` during the current server session. Content is held in-process and cleared on restart. No config required.

---

## Operations

Every `tqnn_get` call specifies one of three operations:

| Operation | Description | When to use |
|---|---|---|
| `ping` | Is the resource reachable? Returns status only, no content. | Health checks, existence verification |
| `info` | Metadata: size, content type, last modified, resolver. No content body. | Before fetching large files |
| `fetch` | Full content retrieval. Text returned inline; binary as base64. Large files auto-zipped. | When you need the content |

Always `ping` or `info` before `fetch` for large or cold resources.

---

## Status codes

| Status | Meaning |
|---|---|
| `AVAILABLE` | Resource exists and is reachable |
| `OK` | Fetch succeeded — content in response |
| `NOT_FOUND` | Resolver matched but resource does not exist at that location |
| `NO_RESOLVER` | No resolver configured for this logical prefix |
| `RESOLVER_NOT_CONFIGURED` | Resolver entry exists but required ENV var not set |
| `COLD_STORAGE` | Resource is in cold storage — submit fetch to initiate retrieval |
| `RETRIEVAL_PENDING` | Cold storage retrieval initiated — poll with ticket_id |
| `TOO_LARGE` | File exceeds `max_fetch_bytes` — use `info` to inspect first |
| `PASSTHROUGH_NOT_CONFIGURED` | Non-logical ref with no `*` catch-all webhook configured |
| `WEBHOOK_UNREACHABLE` | Webhook endpoint did not respond |
| `ERROR` | Unhandled resolver error — check server logs |

---

## Dynamic file redirection in resolver.js

`tqnn_resolvers.json` handles the common cases, but `resolver.js` is designed to be extended. Developers can add custom handler logic for more advanced redirection scenarios.

### Example: record ID → file lookup

If you want filereferences like `patients_NHS::7857655619::` to map to individual JSON files by NHS number rather than JSONL line extraction, add a custom handler in `resolver.js`:

```javascript
// In resolver.js — add to the switch(resolver.handler) block:

case 'local_json_by_id':
  return await handleLocalJsonById(ref, operation, resolver);
```

```javascript
// New handler function:

async function handleLocalJsonById(ref, operation, resolverConfig) {
  const cfg = resolverConfig.config || {};
  const basePath = cfg.base_path || '/home/tqnn/data/';

  // Extract record ID from filereference
  // e.g. "patients_NHS::7857655619::ruby-smith::" → "7857655619"
  const parts = normaliseRef(ref).replace(/::$/, '').split('::');
  const recordId = parts[1]; // second segment after the namespace
  const filepath = path.join(basePath, `${recordId}.json`);

  if (operation === 'ping') {
    try {
      await fs.promises.access(filepath, fs.constants.R_OK);
      return { status: 'AVAILABLE', resolver: 'local_json_by_id', filereference: ref, path: filepath };
    } catch {
      return { status: 'NOT_FOUND', resolver: 'local_json_by_id', filereference: ref };
    }
  }

  if (operation === 'info') {
    try {
      const stat = await fs.promises.stat(filepath);
      return {
        status: 'AVAILABLE',
        resolver: 'local_json_by_id',
        filereference: ref,
        path: filepath,
        size_bytes: stat.size,
        modified: stat.mtime.toISOString(),
        content_type: 'application/json'
      };
    } catch {
      return { status: 'NOT_FOUND', resolver: 'local_json_by_id', filereference: ref };
    }
  }

  if (operation === 'fetch') {
    try {
      const content = await fs.promises.readFile(filepath, cfg.encoding || 'utf8');
      return {
        status: 'OK',
        resolver: 'local_json_by_id',
        filereference: ref,
        content_type: 'application/json',
        size_bytes: Buffer.byteLength(content, 'utf8'),
        encoding: 'utf8',
        content,
        compressed: false
      };
    } catch {
      return { status: 'NOT_FOUND', resolver: 'local_json_by_id', filereference: ref };
    }
  }
}
```

Then configure it in `tqnn_resolvers.json`:

```json
{
  "scheme": "patients_",
  "type": "local_json_by_id",
  "handler": "local_json_by_id",
  "config": {
    "base_path": "/home/tqnn/data/patients/",
    "encoding": "utf8"
  }
}
```

### Example: storage migration redirect

If your S3 bucket was renamed and you have a mix of old and new filereferences in DMM, handle the redirect transparently in your webhook middleware:

```javascript
// middleware.js — your developer-controlled webhook endpoint

app.post('/resolve', (req, res) => {
  const { filereference, operation } = req.body;

  // Remap old bucket references to new bucket
  const remapped = filereference
    .replace('contracts_acme::old-bucket::', 'contracts_acme::new-bucket::');

  // Fetch from new location and return content
  fetchFromS3(remapped, operation).then(result => res.json(result));
});
```

DMM filereferences are never updated. Only your middleware changes.

---

## Ingestion recommendations

The filereference you write at ingest time is the retrieval contract. Follow these conventions to ensure `tqnn_get` resolves correctly:

**Use logical namespace prefixes.** Always start filereferences with `[a-zA-Z0-9]+_`:
```
✓  records_0002.jsonl::line5975::REC-00025975::
✓  invoices_2024::INV-00293::
✗  /home/tqnn/data/records_0002.jsonl::line5975::   ← physical path, breaks on migration
✗  https://s3.amazonaws.com/bucket/file.json::      ← URL baked in, breaks on bucket rename
```

**Include enough context in the filereference** for the resolver to locate the record:
- For JSONL files: `namespace_filename::lineN::record-id::`
- For individual files: `namespace_id::record-id::`
- For databases: `namespace_table::primary-key::`

**Use NHS numbers, invoice IDs, contract IDs as record identifiers** — not names or emails. Structured identifiers index cleanly as single tokens. Email addresses containing `.` and `@` are stripped by the tokeniser and should be stored as a separate token if searchability is required.

---

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `RESOLVER_CONTRACTS_WEBHOOK_URL` | `contracts_` handler | Webhook for contract documents |
| `RESOLVER_SHAREPOINT_WEBHOOK_URL` | `sharepoint_` handler | Webhook for M365/SharePoint |
| `RESOLVER_ARCHIVE_WEBHOOK_URL` | `archive_` handler | Webhook for cold archive |
| `RESOLVER_GLACIER_WEBHOOK_URL` | `glacier://` handler | Webhook for AWS Glacier |
| `RESOLVER_DEFAULT_WEBHOOK_URL` | `*` catch-all | Webhook for all non-logical refs |
| `RESOLVER_WEBHOOK_SECRET` | All webhook handlers | Shared secret in `X-TQNN-Secret` header |

All values support `ENV:VAR_NAME` syntax in `tqnn_resolvers.json` — secrets never need to be written into the config file.
