import type { Theme } from "./tokens.js";
import { BUILT_INS, ChovyDefault } from "./tokens.js";

export function resolveTheme(name: string, custom?: Record<string, string> | null): Theme {
  const base = BUILT_INS.find((t) => t.name === name) ?? ChovyDefault;
  const merged = { ...base };
  if (custom) {
    for (const [k, v] of Object.entries(custom)) {
      if (v !== undefined) {
        (merged as any)[k] = v;
      }
    }
  }
  return merged;
}
