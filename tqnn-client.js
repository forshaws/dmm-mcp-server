// tqnn-client.js — Core DMM HTTP calls using multipart/form-data
// TQNN MCP Server v1.9.0
//
// All DMM API calls use multipart/form-data, NOT JSON body.
// Uses Node 18+ built-in FormData + fetch — no extra npm package needed.
// For tqnn.local (self-signed cert): set NODE_TLS_REJECT_UNAUTHORIZED=0 in env.

const crypto = require('crypto');

class TQNNClient {
  constructor({ baseUrl, apiKey, apiSecret, dataset = '' }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.dataset = dataset;
  }

  async _post(endpoint, fields) {
    const form = new FormData();
    form.append('tqnnAPIKEY', this.apiKey);
    form.append('tqnnAPISECRET', this.apiSecret);
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, String(v));
    }
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      body: form
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  /**
   * Search DMM associative memory for documents matching a PQR-hashed pattern.
   * @param {string} pattern - PQR hash (SHA-256 of token padded to 16 chars)
   * @param {string} [dataset] - Optional dataset override
   * @returns {Promise<ApiResponse>}
   */
  async searchDoc(pattern, dataset) {
    return this._post('/v1/searchDoc', {
      pattern,
      return_filelist: '1',
      ...(dataset || this.dataset ? { dataset: dataset || this.dataset } : {})
    });
  }

  /**
   * Store a document reference and metadata into DMM associative memory.
   * @param {string} filereference - URI/path ending with ::
   * @param {string} pattern - JSON string of document metadata
   * @param {string} [dataset] - Optional dataset override
   * @param {boolean} [createOts] - Submit to OpenTimestamps if true
   * @returns {Promise<ApiResponse>}
   */
  async storeDoc(filereference, pattern, dataset, createOts = false) {
    return this._post('/v1/storeDoc', {
      filereference,
      pattern,
      ...(createOts ? { create_ots: '1' } : {}),
      ...(dataset || this.dataset ? { dataset: dataset || this.dataset } : {})
    });
  }

  /**
   * Lightweight connectivity ping using a known-harmless token.
   *
   * v1.9.0 — DELIBERATELY does NOT use the real (keyed) PQR pipeline from
   * similarity.js. Two reasons:
   *
   *   1. ping() exists purely to check "is DMM reachable" — nothing reads
   *      or cares about the specific hash value it sends, it's disposable
   *      on every call. It carries no real PII and protects nothing.
   *   2. Making it depend on similarity.js's pqrHash() would mean
   *      tqnn_status (a basic health check) hard-fails with a "TQNN_PQR_KEY
   *      not configured" error on any deployment that hasn't set up PQR
   *      yet — even one that only ever uses pqr:false raw-token mode and
   *      has no reason to configure a PQR key at all. A connectivity probe
   *      shouldn't have a hard dependency on an unrelated, optional
   *      feature's configuration.
   *
   * This previously reimplemented the V1.3.0 self-salting hash chain
   * inline as its own second copy of that algorithm — a duplication risk
   * once similarity.js's real algorithm changed (as it just did, to the
   * keyed V1.9.0 scheme). Keeping a SEPARATE, clearly-labelled, non-keyed
   * sentinel hash here — rather than silently re-copying whatever
   * similarity.js does this week — makes the "this is not the security
   * path" property explicit instead of accidental. If similarity.js's
   * algorithm changes again, this function does NOT need to change to
   * match it, and that's intentional, not drift.
   * @returns {Promise<ApiResponse>}
   */
  async ping() {
    const input    = '__ping__';
    const h1       = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
    const padded   = (input + h1).slice(0, 16);
    const pingHash = crypto.createHash('sha256').update(padded, 'utf8').digest('hex').slice(0, 16);
    return this._post('/v1/searchDoc', {
      pattern: pingHash,
      ...(this.dataset ? { dataset: this.dataset } : {})
    });
  }

  /**
   * Discover which datasets the caller's own credentials can access.
   * Sub-credentials get back their exact ACL whitelist; owner credentials
   * get back the full dataset list in their namespace.
   * No dataset param — this call is inherently credential-scoped, not
   * dataset-scoped (there's nothing to pass).
   * @returns {Promise<ApiResponse>}
   */
  async discoverDatasets() {
    return this._post('/v1/discoverDatasets', {});
  }

  /**
   * Authenticate credentials against DMM.
   */
  async authID(username, password, { multihash = 0, returnauthtoken = 0, dataset } = {}) {
    return this._post('/v1/authID', {
      username,
      password,
      ...(multihash ? { multihash: '1' } : {}),
      ...(returnauthtoken ? { returnauthtoken: '1' } : {}),
      ...(dataset || this.dataset ? { dataset: dataset || this.dataset } : {})
    });
  }

  /**
   * Register credentials in DMM.
   */
  async registerID(credentials, { multihash = 0, returnauthtoken = 0, dataset } = {}) {
    const fields = {};
    credentials.forEach((cred, i) => { fields[`credential${i}`] = cred; });
    return this._post('/v1/registerID', {
      ...fields,
      ...(multihash ? { multihash: '1' } : {}),
      ...(returnauthtoken ? { returnauthtoken: '1' } : {}),
      ...(dataset || this.dataset ? { dataset: dataset || this.dataset } : {})
    });
  }
}

module.exports = { TQNNClient };
