// tqnn_mcp_hash_password.js — generate a password_hash value for tqnn_mcp_users.json
//
// Usage:
//   node tqnn_mcp_hash_password.js "the employee's password"
//
// Copy the printed hash into the "password_hash" field for that employee
// in tqnn_mcp_users.json. Each run produces a different hash (random salt)
// even for the same password — that's expected, either output works.

'use strict';

const { hashPassword } = require('./oauth');

const password = process.argv[2];

if (!password) {
  process.stderr.write('Usage: node tqnn_mcp_hash_password.js "<password>"\n');
  process.exit(1);
}

if (password.length < 12) {
  process.stderr.write('Warning: password is under 12 characters — consider something longer.\n');
}

console.log(hashPassword(password));
