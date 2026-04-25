/**
 * Derive a human-readable engineer name from a task title.
 *
 * Strategy: strip articles/prepositions (stopwords), take the first two
 * remaining tokens, format as `engineer-<token1>-<token2>`.
 * Falls back to `engineer-<N>` when the title is empty or produces fewer
 * than 2 useful tokens.
 */

const STOPWORDS = new Set([
  "the", "a", "an",
  "in", "on", "of", "to", "for", "with", "at", "by", "from",
  "and", "or", "but", "as", "into", "onto", "upon",
])

/** Max total length of the final name string (incl. "engineer-" prefix). */
const MAX_NAME_LENGTH = 40

/**
 * Normalise a raw title token: lowercase, keep only a-z0-9, return empty
 * string if nothing remains.
 */
function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Derive `engineer-<verb>-<noun>` from `taskTitle`.
 * Falls back to `engineer-<fallbackIndex>` when fewer than 2 tokens survive
 * after stopword removal and normalisation.
 */
export function deriveEngineerName(
  taskTitle: string | null | undefined,
  fallbackIndex: number,
): string {
  const fallback = `engineer-${fallbackIndex}`

  if (!taskTitle || !taskTitle.trim()) {
    return fallback
  }

  // Split on any non-word boundary (whitespace, dashes, slashes, etc.)
  const rawTokens = taskTitle.trim().split(/[\s\-_/\\]+/)

  const tokens: string[] = []
  for (const raw of rawTokens) {
    const tok = normalizeToken(raw)
    if (!tok) continue
    if (STOPWORDS.has(tok)) continue
    tokens.push(tok)
    if (tokens.length === 2) break
  }

  if (tokens.length < 2) {
    return fallback
  }

  const candidate = `engineer-${tokens[0]}-${tokens[1]}`

  // Truncate cleanly at a hyphen boundary if over the limit
  if (candidate.length <= MAX_NAME_LENGTH) {
    return candidate
  }

  const truncated = candidate.slice(0, MAX_NAME_LENGTH)
  // Walk back to the last hyphen so we don't leave a partial token
  const lastHyphen = truncated.lastIndexOf("-")
  return lastHyphen > "engineer-".length - 1 ? truncated.slice(0, lastHyphen) : truncated
}
