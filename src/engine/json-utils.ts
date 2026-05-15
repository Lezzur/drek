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
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

  // ```json … ``` or ``` … ``` fences
  const fence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) return fence[1]!.trim();

  // Otherwise grab from the first { or [ to the matching closing bracket
  // (whichever appears first). Naïve last-index match works for our prompts
  // because we instruct the model to emit a single top-level value.
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const start =
    firstObj === -1
      ? firstArr
      : firstArr === -1
        ? firstObj
        : Math.min(firstObj, firstArr);
  if (start === -1) return trimmed;
  const openChar = trimmed[start];
  const closeChar = openChar === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(closeChar);
  if (end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

/**
 * Parse + extract in one go. Returns the parsed value or throws — same as
 * JSON.parse, so the caller's try/catch only needs to handle one error case.
 */
export function parseExtractedJson(text: string): unknown {
  return JSON.parse(extractJson(text));
}
