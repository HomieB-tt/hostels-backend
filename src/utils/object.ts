/**
 * Strips keys whose value is explicitly `undefined`, narrowing the type
 * to match — bridges a real gap under exactOptionalPropertyTypes:true
 * between zod's optional-output typing (`field?: T | undefined`, since
 * zod's inferred type allows a key to be present WITH value undefined)
 * and Drizzle's generated insert/update types (`field?: T`, which do NOT
 * accept an explicit undefined even though the key itself is optional).
 * Without this, passing zod-parsed data straight into `.values()`/`.set()`
 * fails to compile despite being safe at runtime.
 */
export function omitUndefined<T extends object>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) result[key] = value;
  }
  return result as { [K in keyof T]: Exclude<T[K], undefined> };
}
