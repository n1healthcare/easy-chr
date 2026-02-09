/**
 * Deep merge a JSON patch into an original object.
 *
 * Rules:
 * - Objects: recursively merge (patch overrides, original preserved for missing keys)
 * - Arrays: if first element has _action: "replace", replace entire array (without the marker).
 *           Otherwise, append new items to existing array.
 * - Primitives: patch overrides original.
 * - null in patch: sets field to null (explicit clear).
 */
export function deepMergeJsonPatch(
  original: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...original };

  for (const [key, patchValue] of Object.entries(patch)) {
    const originalValue = result[key];

    if (patchValue === null) {
      // Explicit null — set it
      result[key] = null;
    } else if (Array.isArray(patchValue)) {
      // Array handling
      if (
        patchValue.length > 0 &&
        typeof patchValue[0] === 'object' &&
        patchValue[0] !== null &&
        (patchValue[0] as Record<string, unknown>)._action === 'replace'
      ) {
        // Replace mode: drop the marker, use the rest as the new array
        result[key] = patchValue.slice(1);
      } else if (Array.isArray(originalValue)) {
        // Append mode: add new items to existing array
        result[key] = [...originalValue, ...patchValue];
      } else {
        // Original wasn't an array, just set it
        result[key] = patchValue;
      }
    } else if (
      typeof patchValue === 'object' &&
      typeof originalValue === 'object' &&
      originalValue !== null &&
      !Array.isArray(originalValue)
    ) {
      // Both are objects — recurse
      result[key] = deepMergeJsonPatch(
        originalValue as Record<string, unknown>,
        patchValue as Record<string, unknown>
      );
    } else {
      // Primitive or type change — override
      result[key] = patchValue;
    }
  }

  return result;
}
