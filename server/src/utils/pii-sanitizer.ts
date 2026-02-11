/**
 * PII Sanitization for log messages.
 *
 * Detects and masks PII (Personally Identifiable Information) from log
 * messages. Designed to be safe for medical text — won't match generic
 * uses of words like "patient" or "user" in medical context.
 *
 * Supported PII types:
 * - Email addresses
 * - Phone numbers (US formats)
 * - SSN (Social Security Numbers)
 * - Names in structured data (JSON keys, assignments)
 */

// Compiled patterns ordered from most specific to least specific
const PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // Email addresses
  {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[REDACTED-EMAIL]',
  },
  // Phone numbers (various US formats) — word boundaries prevent matching IDs
  {
    regex: /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[REDACTED-PHONE]',
  },
  // SSN pattern
  {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED-SSN]',
  },
  // Names in JSON/dict format (safe — only matches structured data)
  {
    regex: /(['"])(first_name|last_name|patient_name|user_name|full_name|name)\1\s*:\s*(['"])([^'"]+)\3/gi,
    replacement: '$1$2$1: $3[REDACTED-NAME]$3',
  },
  // Names in assignment/log format (safe — requires explicit label)
  {
    regex: /\b(first_name|last_name|patient_name|user_name|full_name|name)(\s*[=:]\s*)['"]?([A-Za-z][A-Za-z\s]*?)['"]?(?=\s|,|$|\)|\]|})/gi,
    replacement: '$1$2[REDACTED-NAME]',
  },
];

// Keys that should be fully redacted when found in objects
const SENSITIVE_KEYS = new Set([
  'email',
  'name',
  'first_name',
  'last_name',
  'phone',
  'ssn',
  'patient_name',
  'user_name',
  'full_name',
]);

/**
 * Sanitize PII from a log message string.
 *
 * Safe for medical text — won't match "the patient has insomnia".
 * Will match structured data like {"first_name": "John"}.
 */
export function sanitizeLogMessage(msg: string): string {
  if (!msg) return msg;
  let result = msg;
  for (const { regex, replacement } of PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Recursively sanitize PII in object values.
 * Used for structured log data (bindings, extras).
 */
export function sanitizeObjectValues(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase();
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeObjectValues(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return sanitizeObjectValues(item as Record<string, unknown>);
        }
        if (typeof item === 'string') {
          const sanitized = sanitizeLogMessage(item);
          if (sanitized !== item) return sanitized;
          return SENSITIVE_KEYS.has(keyLower) ? '[REDACTED]' : item;
        }
        return item;
      });
    } else if (typeof value === 'string') {
      const sanitized = sanitizeLogMessage(value);
      if (sanitized !== value) {
        result[key] = sanitized;
      } else if (SENSITIVE_KEYS.has(keyLower)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}
