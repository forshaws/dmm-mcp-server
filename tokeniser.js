// tokeniser.js — General-purpose tokeniser for TQNN similarity search
// Ported from lindisfarne_similarity_search.py

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
 * @param {string} text - Any free text input
 * @returns {string[]} - Array of unique meaningful tokens
 */
function tokenise(text) {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const seen = new Set();
  const tokens = [];
  for (const word of words) {
    if (word.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(word) && !seen.has(word)) {
      seen.add(word);
      tokens.push(word);
    }
  }
  return tokens;
}

module.exports = { tokenise };
