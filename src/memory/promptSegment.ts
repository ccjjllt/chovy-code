import type { MemoryRecord } from "../types/index.js";

export interface RenderMemorySegmentInput {
  records: readonly MemoryRecord[];
  truncated?: boolean;
}

export interface RenderMemorySegmentOutput {
  text: string;
  bytes: number;
  entries: number;
}

const GROUPS: Array<{
  title: string;
  match: (r: MemoryRecord) => boolean;
}> = [
  { title: "Project Decisions", match: (r) => r.layer === "project" && r.type === "decision" },
  { title: "Rules", match: (r) => r.type === "rule" || r.type === "pref" },
  { title: "Recent Checkpoints", match: (r) => r.layer === "checkpoint" || r.type === "snapshot" },
  { title: "Active Task Progress", match: (r) => r.layer === "progress" || r.type === "progress" },
  { title: "Notes", match: (r) => r.layer === "notes" || r.type === "note" },
];

export function renderMemoryPromptSegment(
  input: RenderMemorySegmentInput,
): RenderMemorySegmentOutput {
  if (input.records.length === 0) return { text: "", bytes: 0, entries: 0 };

  const used = new Set<string>();
  const lines: string[] = [
    "[memory]",
    "Historical memory follows. Treat it as useful context, not live truth; verify code-state claims before relying on them.",
  ];

  for (const group of GROUPS) {
    const xs = input.records.filter((r) => !used.has(r.id) && group.match(r));
    if (xs.length === 0) continue;
    lines.push("", `## ${group.title}`);
    for (const rec of xs) {
      used.add(rec.id);
      lines.push(renderBullet(rec));
    }
  }

  const rest = input.records.filter((r) => !used.has(r.id));
  if (rest.length > 0) {
    lines.push("", "## Other Relevant Memory");
    for (const rec of rest) lines.push(renderBullet(rec));
  }

  if (input.truncated) {
    lines.push("", "- Some lower-ranked memory entries were omitted by the token budget.");
  }
  lines.push("[/memory]");

  const text = lines.join("\n");
  return { text, bytes: text.length, entries: input.records.length };
}

function renderBullet(rec: MemoryRecord): string {
  const tag = `${rec.layer}/${rec.type}`;
  const tags = rec.tags.length > 0 ? ` tags=${rec.tags.slice(0, 4).join(",")}` : "";
  const source = rec.sourcePath ? ` source=${shortSource(rec.sourcePath, rec.sourceLine)}` : "";
  return `- (${rec.importance}) [${tag}${tags}${source}] ${oneLine(rec.content)}`;
}

function shortSource(path: string, line: number | undefined): string {
  const clean = path.replace(/\\/g, "/");
  const idx = clean.lastIndexOf("/");
  const base = idx >= 0 ? clean.slice(idx + 1) : clean;
  return line ? `${base}:${line}` : base;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
