import { Text } from "ink";
import { useTheme } from "../theme/index.js";

export function HighlightedLabel({ text, positions }: { text: string; positions: number[] }) {
  const theme = useTheme();
  if (positions.length === 0) return <Text>{text}</Text>;
  const set = new Set(positions);
  const parts: { text: string; hit: boolean }[] = [];
  let cur = "";
  let curHit: boolean | null = null;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const char = text.charAt(i);
    if (curHit === null || curHit === hit) { 
      cur += char; 
      curHit = hit; 
    } else { 
      parts.push({ text: cur, hit: curHit }); 
      cur = char; 
      curHit = hit; 
    }
  }
  if (cur) parts.push({ text: cur, hit: curHit ?? false });
  return (
    <Text>
      {parts.map((p, i) => p.hit
        ? <Text key={i} bold color={theme.accent}>{p.text}</Text>
        : <Text key={i}>{p.text}</Text>
      )}
    </Text>
  );
}
