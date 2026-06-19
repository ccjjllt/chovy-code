import { useMemo } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/index.js";
import { useTerminalCaps } from "../tui/capabilities.js";
import { useKeybinding } from "../keybindings/index.js";
import { PaletteHeader } from "./PaletteHeader.js";
import { PaletteInput } from "./PaletteInput.js";
import { PaletteList } from "./PaletteList.js";
import { usePaletteState, closePalette, movePaletteCursor, setPaletteQuery, type Group, type PaletteCommand } from "./state.js";
import type { ReplCtx } from "../cli/slashCommands.js";

function getCommands(_ctx: ReplCtx): PaletteCommand[] {
  return [
    { id: "sample.cmd1", label: () => "Sample Command 1", hotkey: "Ctrl+S", run: () => {} },
    { id: "sample.cmd2", label: () => "Sample Command 2", run: () => {} },
  ];
}

function groupAndFilter(commands: PaletteCommand[], query: string): Group[] {
  const filtered = commands.filter(c => c.label().toLowerCase().includes(query.toLowerCase()));
  if (filtered.length === 0) return [];
  return [{ id: "sample", items: filtered }];
}

function flatten(grouped: Group[]): PaletteCommand[] {
  return grouped.flatMap(g => g.items);
}

function execAt(flat: PaletteCommand[], index: number, ctx: ReplCtx) {
  const cmd = flat[index];
  if (cmd) {
    cmd.run(ctx);
    closePalette();
  }
}

export function InlinePaletteFallback({ ctx }: { ctx: ReplCtx }) {
  const theme = useTheme();
  const { open, query, selectedIndex } = usePaletteState();

  const grouped = useMemo(() => groupAndFilter(getCommands(ctx), query), [query]);
  const flat = useMemo(() => flatten(grouped), [grouped]);

  useKeybinding("palette.up",    () => movePaletteCursor(-1), { isActive: open });
  useKeybinding("palette.down",  () => movePaletteCursor(1),  { isActive: open });
  useKeybinding("palette.exec",  () => execAt(flat, selectedIndex, ctx), { isActive: open });
  useKeybinding("palette.close", () => closePalette(), { isActive: open });

  const activeItem = flat[selectedIndex];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>-- Command Mode (Inline Fallback) --</Text>
      <PaletteInput value={query} onChange={setPaletteQuery} />
      {activeItem && (
        <Text color={theme.accent}>Selected: {activeItem.label()}</Text>
      )}
      <Text dimColor>↑↓ select · Enter exec · Esc close</Text>
    </Box>
  );
}

export function CommandPalette({ ctx }: { ctx: ReplCtx }) {
  const { open, query, selectedIndex } = usePaletteState();
  if (!open) return null;
  if (process.env["CHOVY_NO_PALETTE"] === "1") return <InlinePaletteFallback ctx={ctx} />;

  const grouped = useMemo(() => groupAndFilter(getCommands(ctx), query), [query]);
  const flat = useMemo(() => flatten(grouped), [grouped]);

  useKeybinding("palette.up",    () => movePaletteCursor(-1), { isActive: open });
  useKeybinding("palette.down",  () => movePaletteCursor(1),  { isActive: open });
  useKeybinding("palette.exec",  () => execAt(flat, selectedIndex, ctx), { isActive: open });
  useKeybinding("palette.close", () => closePalette(), { isActive: open });

  const theme = useTheme();
  const caps = useTerminalCaps();
  const width = Math.min(caps.cols - 4, 80);

  return (
    <Box flexDirection="column"
         borderStyle={theme.borderStyle} borderColor={theme.accent}
         paddingX={1} width={width} height={Math.min(caps.rows - 4, 24)}>
      <PaletteHeader />
      <PaletteInput value={query} onChange={setPaletteQuery} />
      <Box flexDirection="column" flexGrow={1}>
        <PaletteList grouped={grouped} selectedIndex={selectedIndex} />
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>↑↓ 选择 · Enter 执行 · Esc 关闭</Text>
        <Text dimColor>{`${flat.length} 项`}</Text>
      </Box>
    </Box>
  );
}
