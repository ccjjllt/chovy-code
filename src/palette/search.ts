import type { Locale } from "../i18n/locales.js";
import { toInitials } from "./pinyin-match.js";
import type { PaletteCommand } from "./state.js";

export interface MatchResult {
  score: number;            // 越大越好；< 0 = 不匹配
  positions: number[];      // 命中的字符索引（用于高亮）
}

function scoreSubstring(label: string, query: string): MatchResult {
  const labelL = label.toLowerCase();
  const queryL = query.toLowerCase();
  const idx = labelL.indexOf(queryL);
  if (idx < 0) return { score: -1, positions: [] };
  
  const score = 100 + (10 - Math.min(idx, 10));
  const positions: number[] = [];
  for (let i = 0; i < query.length; i++) {
    positions.push(idx + i);
  }
  return { score, positions };
}

function scoreFuzzy(label: string, query: string): MatchResult {
  const labelL = label.toLowerCase();
  const queryL = query.toLowerCase();
  let qi = 0;
  const positions: number[] = [];
  let score = 50;
  let lastIdx = -2;

  for (let i = 0; i < labelL.length && qi < queryL.length; i++) {
    if (labelL[i] === queryL[qi]) {
      positions.push(i);
      if (i === lastIdx + 1) {
        score += 5;
      }
      lastIdx = i;
      qi++;
    }
  }

  if (qi === queryL.length) {
    return { score, positions };
  }
  return { score: -1, positions: [] };
}

function scorePinyinInitials(label: string, query: string): MatchResult {
  const queryL = query.toLowerCase();
  const initials = toInitials(label).toLowerCase();
  
  let qi = 0;
  const positions: number[] = [];
  let score = 40;
  let lastIdx = -2;

  for (let i = 0; i < initials.length && qi < queryL.length; i++) {
    if (initials[i] === queryL[qi]) {
      positions.push(i);
      if (i === lastIdx + 1) {
        score += 5;
      }
      lastIdx = i;
      qi++;
    }
  }

  if (qi === queryL.length) {
    return { score, positions };
  }
  return { score: -1, positions: [] };
}

function scoreTrigram(label: string, query: string): MatchResult {
  if (query.length < 2) return { score: -1, positions: [] };
  const labelL = label.toLowerCase();
  const queryL = query.toLowerCase();
  
  const positions = new Set<number>();
  let matchCount = 0;
  
  const ngrams = [];
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i <= queryL.length - n; i++) {
      ngrams.push(queryL.slice(i, i + n));
    }
  }

  if (ngrams.length === 0) return { score: -1, positions: [] };

  for (const ng of ngrams) {
    let idx = labelL.indexOf(ng);
    while (idx !== -1) {
      matchCount++;
      for (let i = 0; i < ng.length; i++) positions.add(idx + i);
      idx = labelL.indexOf(ng, idx + 1);
    }
  }

  if (matchCount > 0) {
    return { score: 30 + matchCount, positions: Array.from(positions).sort((a, b) => a - b) };
  }

  return { score: -1, positions: [] };
}

export function scoreMatch(label: string, query: string, locale: Locale): MatchResult {
  if (!query) return { score: 1, positions: [] };
  const a = scoreSubstring(label, query);
  const b = scoreFuzzy(label, query);
  const c = locale === "zh" ? scorePinyinInitials(label, query) : { score: -1, positions: [] };
  const d = locale === "zh" && query.length >= 2 ? scoreTrigram(label, query) : { score: -1, positions: [] };
  return [a, b, c, d].reduce((best, cur) => cur.score > best.score ? cur : best);
}

export function filterAndSort(commands: PaletteCommand[], query: string, locale: Locale): { item: PaletteCommand; result: MatchResult }[] {
  const out: { item: PaletteCommand; result: MatchResult }[] = [];
  for (const c of commands) {
    const r = scoreMatch(c.label(), query, locale);
    if (r.score > 0) out.push({ item: c, result: r });
  }
  out.sort((a, b) => b.result.score - a.result.score);
  return out.slice(0, 50);
}
