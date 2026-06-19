import type { KeyBinding } from "./defaults.js";

export function detectConflicts(
  bindings: KeyBinding[],
  userOverride: Record<string, string | null>
): Array<{ key: string; ids: string[]; scope: string }> {
  // get final key for each id
  const map = new Map<string, { id: string; key: string; scope: string }>();

  for (const b of bindings) {
    const override = userOverride[b.id];
    let key = b.defaultKey;
    if (override !== undefined) {
      if (override === null) continue; // Unbound
      key = override;
    }
    map.set(b.id, { id: b.id, key, scope: b.scope });
  }

  // Group by (key, scope)
  // Actually, global scope conflicts with any other scope
  const conflicts: Array<{ key: string; ids: string[]; scope: string }> = [];

  const grouped = new Map<string, Array<{ id: string; scope: string }>>();

  for (const item of map.values()) {
    const arr = grouped.get(item.key) || [];
    arr.push({ id: item.id, scope: item.scope });
    grouped.set(item.key, arr);
  }

  for (const [key, items] of grouped.entries()) {
    if (items.length > 1) {
      // Check if they overlap in scope
      // "global" overlaps with anything
      // "input" overlaps with "input" and "global"
      // "palette" overlaps with "palette" and "global"
      // "settings" overlaps with "settings" and "global"

      const hasGlobal = items.some((i) => i.scope === "global");
      const scopes = new Set(items.map((i) => i.scope));

      // If there's global, all of them conflict.
      // If no global, and they are in the same scope, they conflict.
      if (hasGlobal || scopes.size < items.length) {
        conflicts.push({
          key,
          ids: items.map((i) => i.id),
          scope: hasGlobal ? "global" : items[0]!.scope,
        });
      }
    }
  }

  return conflicts;
}
