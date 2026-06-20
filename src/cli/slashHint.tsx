import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import { listSlashes } from "../palette/registry.js";
import { scoreMatch } from "../palette/search.js";
import { getLocale } from "../i18n/index.js";
import type { ReplCtx } from "./slashCommands.js";

export function findActiveSlash(buffer: string): { commandHead: string } | null {
  if (!buffer.startsWith("/")) return null;
  const match = buffer.match(/^(\/\S*)/);
  if (!match) return null;
  return { commandHead: match[1]! };
}

export function searchSlashCommands(head: string, ctx?: ReplCtx) {
  const query = head.slice(1);
  const locale = getLocale();
  const allSlashes = listSlashes(ctx as any);
  
  const scored = allSlashes.map(s => {
    const label = s.display.slice(1);
    const result = scoreMatch(label, query, locale);
    return { item: s, score: result.score };
  });

  return scored
    .filter(x => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.item);
}

export function SlashHint({ buffer, ctx }: { buffer: string; ctx?: ReplCtx }) {
  const slash = findActiveSlash(buffer);
  if (!slash) return null;
  const head = slash.commandHead;
  if (!head) return null;

  const matches = searchSlashCommands(head, ctx);
  if (matches.length === 0) return null;

  const top = matches[0]!;
  const theme = useTheme();

  return (
    <Box marginLeft={1}>
      <Text dimColor>{`→ ${top.display}`}</Text>
      {matches.length > 1 ? <Text dimColor>{` (+${matches.length - 1})`}</Text> : null}
      <Text color={theme.accent}>{` Tab 补全`}</Text>
    </Box>
  );
}
