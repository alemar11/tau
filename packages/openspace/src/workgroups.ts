export const DEFAULT_WORKGROUP = "default";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** Validate configured/saved specific groups, never the effective wire roster. */
export function normalizeSpecificWorkgroups(input: readonly string[]): string[] {
  const groups = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || CONTROL_CHARACTER.test(value) || value.includes(",")) {
      throw new Error("workgroup names must be strings without commas or control characters");
    }
    const name = value.trim();
    if (!name) throw new Error("workgroup names must not be empty");
    if (name === DEFAULT_WORKGROUP) {
      throw new Error('"default" is reserved for the automatic fallback, not a configurable workgroup');
    }
    groups.add(name);
  }
  return [...groups];
}

export function parseWorkgroups(value: string | undefined): string[] {
  return value?.trim() ? normalizeSpecificWorkgroups(value.split(",")) : [];
}

export function effectiveWorkgroups(specific: readonly string[]): string[] {
  const groups = normalizeSpecificWorkgroups(specific);
  return groups.length ? groups : [DEFAULT_WORKGROUP];
}
