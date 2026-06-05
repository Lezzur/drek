/**
 * Tolerant JSON extraction for LLM-CLI output. The CLI prompts ask for
 * "JSON only", but real-world models occasionally:
 *   - wrap the JSON in ```json … ``` fences
 *   - prepend a line like "Here is the JSON:" before the actual object
 *   - emit trailing whitespace or a stray comment
 *
 * extractJson() strips those wrappers and returns the inner JSON text. The
 * caller is still responsible for JSON.parse + schema validation; this just
 * finds the JSON-shaped body.
 *
 * Returns the raw string when no wrappers are detected — so a clean response
 * passes through unchanged.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  // ```json … ``` or ``` … ``` fences. Check first so fenced output that's
  // followed by an explanatory paragraph still extracts cleanly.
  const fence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  const body = fence ? fence[1]!.trim() : trimmed;

  if (body.startsWith('{') || body.startsWith('[')) {
    return sliceBalanced(body, 0) ?? body;
  }

  // Otherwise grab from the first { or [ to its MATCHING close (whichever
  // opener appears first). A balanced scan — rather than lastIndexOf — so a
  // model that appends trailing prose containing a stray } or ] (e.g.
  // "...}. Note the } above closes it.") doesn't over-capture and corrupt
  // the JSON.
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const start =
    firstObj === -1
      ? firstArr
      : firstArr === -1
        ? firstObj
        : Math.min(firstObj, firstArr);
  if (start === -1) return body;
  return sliceBalanced(body, start) ?? body;
}

/**
 * From an opening `{`/`[` at index `start`, return the substring through its
 * matching close, tracking nesting depth and skipping braces that appear
 * inside string literals (with escape handling). Returns null if the value is
 * unbalanced, so the caller can fall back and let JSON.parse surface the error.
 */
function sliceBalanced(s: string, start: number): string | null {
  const open = s[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse + extract in one go. Returns the parsed value or throws — same as
 * JSON.parse, so the caller's try/catch only needs to handle one error case.
 */
export function parseExtractedJson(text: string): unknown {
  return JSON.parse(extractJson(text));
}
