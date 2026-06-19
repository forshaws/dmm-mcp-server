// tokeniser.js — General-purpose tokeniser for TQNN similarity search
// Ported from lindisfarne_similarity_search.py
// V1.3.1 — Preserve token case for PQR hashing (self-salting scheme is case-sensitive)

const STOPWORDS = new Set([
  // Generic English stopwords
  "this", "that", "with", "from", "they", "them", "their", "what",
  "will", "have", "been", "were", "when", "where", "which", "there",
  "some", "more", "also", "than", "then", "into", "your", "about",
  "would", "could", "should", "each", "other", "these", "those",
  // Domain-neutral common words
  "data", "file", "document", "record", "report", "system", "user",
  "type", "date", "time", "name", "list", "item", "value", "field",
  // Medical domain (retained from Python original)
  "disease", "disorder", "syndrome", "acute", "chronic", "familial",
  "stage", "with", "and", "the", "due", "from", "related",
  "associated", "secondary", "primary", "left", "right",
  "bilateral", "unilateral", "severe", "mild", "moderate",
  "late", "early", "onset"
]);

const MIN_TOKEN_LENGTH = 4;

/**
 * Tokenise free text into meaningful search tokens.
 * Strips stopwords, deduplicates, enforces minimum length.
 * Case is PRESERVED — PQR self-salting scheme (V1.3.0+) is case-sensitive.
 * Stopword matching is case-insensitive (compared against lowercase STOPWORDS set).
 * @param {string} text - Any free text input
 * @returns {string[]} - Array of unique meaningful tokens (original case retained)
 */
function tokenise(text) {
  const words = text.match(/[a-zA-Z]+/g) || [];
  const seen = new Set();
  const tokens = [];
  for (const word of words) {
    if (word.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(word.toLowerCase()) && !seen.has(word)) {
      seen.add(word);
      tokens.push(word);
    }
  }
  return tokens;
}

module.exports = { tokenise };
