import { useState, useEffect } from "react";
import { Text } from "ink";
import { useTheme } from "../theme/index.js";

const HEARTS = [
  "   ♥    ♥   ",
  "  ♥  ♥   ♥  ",
  " ♥   ♥  ♥   ",
  "♥  ♥      ♥ ",
  "·    ·   ·  ",
];

export function PetHearts({ active, onDone }: { active: boolean; onDone: () => void }) {
  const [frame, setFrame] = useState(0);
  
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= HEARTS.length) {
          onDone();
          return 0;
        }
        return f + 1;
      });
    }, 500);
    return () => clearInterval(id);
  }, [active, onDone]);

  if (!active) return null;
  const theme = useTheme();
  return <Text color={theme.error}>{HEARTS[frame]}</Text>;
}
