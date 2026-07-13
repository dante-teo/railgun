/**
 * Extracts a non-empty string value from a loosely-typed args object.
 * Returns undefined if args is not an object, the key is absent, the value
 * is not a string, or the string is empty.
 */
export const extractString = (args: unknown, key: string): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};
