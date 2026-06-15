// tqnn-client.js — Core DMM HTTP calls using multipart/form-data
// TQNN MCP Server v1.0.0
//
// All DMM API calls use multipart/form-data, NOT JSON body.
// Uses Node 18+ built-in FormData + fetch — no extra npm package needed.
// For tqnn.local (self-signed cert): set NODE_TLS_REJECT_UNAUTHORIZED=0 in env.

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
   * Lightweight connectivity ping using a known-harmless hash.
   * @returns {Promise<ApiResponse>}
   */
  async ping() {
    const crypto = require('crypto');
    const token = '__ping__';
    const padded = token.length >= 16 ? token.slice(0, 16) : token.padEnd(16, '*');
    const pingHash = crypto.createHash('sha256').update(padded, 'utf8').digest('hex');
    return this._post('/v1/searchDoc', { pattern: pingHash });
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
