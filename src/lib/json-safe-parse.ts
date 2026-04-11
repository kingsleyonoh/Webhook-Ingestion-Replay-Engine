/**
 * JSON parser with configurable nesting depth limit.
 * Prevents DoS attacks via deeply nested JSON payloads.
 *
 * Scans the raw string for structural depth before calling JSON.parse.
 * Braces inside quoted strings are correctly ignored.
 */

/**
 * Check if JSON string exceeds a maximum nesting depth.
 * Correctly handles strings (braces inside quotes are not counted).
 *
 * @returns true if depth exceeds maxDepth
 */
function exceedsDepth(str: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      if (inString) {
        escape = true;
      }
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{" || char === "[") {
      depth++;
      if (depth > maxDepth) return true;
    } else if (char === "}" || char === "]") {
      depth--;
    }
  }

  return false;
}

/**
 * Parse JSON with a maximum nesting depth limit.
 * Throws if the nesting depth exceeds the limit or if JSON is invalid.
 *
 * @param str - Raw JSON string
 * @param maxDepth - Maximum allowed nesting depth (default: 20)
 * @returns Parsed JSON value
 */
export function safeParse(str: string, maxDepth = 20): unknown {
  if (exceedsDepth(str, maxDepth)) {
    throw new Error(
      `JSON nesting depth exceeds maximum of ${maxDepth}`
    );
  }

  return JSON.parse(str);
}
