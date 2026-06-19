import React from 'react';
import { Box, Text } from 'ink';

export interface ListProps<T> {
  items: T[];
  selectedIndex: number;
  renderItem: (item: T, opts: { selected: boolean; index: number }) => React.ReactNode;
  emptyHint?: string;
  maxVisible?: number;
}

export function List<T>({ items, selectedIndex, renderItem, emptyHint, maxVisible = 10 }: ListProps<T>) {
  if (items.length === 0) {
    return (
      <Box padding={1}>
        <Text dimColor>{emptyHint || 'Empty list'}</Text>
      </Box>
    );
  }

  let start = 0;
  if (items.length > maxVisible) {
    // Keep the selected index somewhat in the middle if possible, or at least visible
    const half = Math.floor(maxVisible / 2);
    start = Math.max(0, Math.min(selectedIndex - half, items.length - maxVisible));
    
    // Ensure selected is within bounds
    if (selectedIndex < start) {
      start = selectedIndex;
    } else if (selectedIndex >= start + maxVisible) {
      start = selectedIndex - maxVisible + 1;
    }
  }
  
  const end = Math.min(items.length, start + maxVisible);
  const visibleItems = items.slice(start, end);
  
  return (
    <Box flexDirection="column">
      {start > 0 ? <Box><Text dimColor>  ▲</Text></Box> : null}
      {visibleItems.map((item, i) => {
        const actualIndex = start + i;
        return (
          <Box key={actualIndex}>
            {renderItem(item, { selected: actualIndex === selectedIndex, index: actualIndex })}
          </Box>
        );
      })}
      {end < items.length ? <Box><Text dimColor>  ▼</Text></Box> : null}
    </Box>
  );
}
