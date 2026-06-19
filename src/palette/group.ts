import type { ReplCtx } from "../cli/slashCommands.js";
import { listCommands, type PaletteCommand } from "./registry.js";
import { readMru, mruScore } from "./recent.js";

export interface GroupedCommands {
  category: string;
  items: PaletteCommand[];
}

export function getGroupedCommands(ctx: ReplCtx, query: string): GroupedCommands[] {
  const commands = listCommands(ctx);
  
  if (query.trim() === "") {
    // Empty query: Show suggested and MRU
    const suggested = commands.filter(c => typeof c.suggested === "function" ? c.suggested(ctx) : !!c.suggested);
    
    const mruData = readMru();
    const now = Date.now();
    const mruScored = commands
      .map(c => ({ c, score: mruScore(mruData.items[c.id]?.count ?? 0, mruData.items[c.id]?.lastUsedAt ?? 0, now) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(x => x.c);
      
    // deduplicate
    const seen = new Set<string>();
    const recommend: PaletteCommand[] = [];
    
    for (const c of [...suggested, ...mruScored]) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        recommend.push(c);
      }
    }
    
    if (recommend.length > 0) {
      return [{ category: "recommend", items: recommend }];
    }
    
    // If no recommend, just show normal grouping, but empty query usually just shows everything or top groups
    return groupByCategory(commands);
  }
  
  // Actually the filtering happens in the step-42 fuzzy search logic, but we provide the basic group here
  // For now, if there is a query, fuzzy search handles it. Here we just return everything grouped.
  return groupByCategory(commands);
}

function groupByCategory(commands: PaletteCommand[]): GroupedCommands[] {
  const map = new Map<string, PaletteCommand[]>();
  for (const c of commands) {
    const arr = map.get(c.category) ?? [];
    arr.push(c);
    map.set(c.category, arr);
  }
  
  const result: GroupedCommands[] = [];
  for (const [category, items] of map.entries()) {
    result.push({ category, items });
  }
  return result;
}
