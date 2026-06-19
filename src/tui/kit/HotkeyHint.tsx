import { Text } from 'ink';
import { useTheme } from '../../theme/index.js';
import { getBinding } from '../../keybindings/index.js';
import { t, useLocale } from '../../i18n/index.js';

export interface HotkeyHintProps {
  id?: string;
  k?: string;
}

export function HotkeyHint({ id, k }: HotkeyHintProps) {
  const theme = useTheme();
  useLocale(); // Subscribe to locale changes
  
  let keyStr = k;
  if (id && !keyStr) {
    try {
      keyStr = getBinding(id);
    } catch {
      keyStr = id;
    }
  }
  
  if (!keyStr) return null;

  const parts = keyStr.split('+');
  const translatedParts = parts.map(part => {
    const lower = part.toLowerCase();
    const mapped = t(`hotkey.modifier.${lower}`);
    if (!mapped.startsWith('[missing:')) {
      return mapped;
    }
    return part;
  });

  return (
    <Text color={theme.muted}>{translatedParts.join('+')}</Text>
  );
}
