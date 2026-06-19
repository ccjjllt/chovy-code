
import { Text } from "ink";
import { stringWidth } from "../stringWidth";

export interface CenterProps {
  children: string;
  width: number;
}

export function Center({ children, width }: CenterProps) {
  const contentWidth = stringWidth(children);
  const leftPad = Math.max(0, Math.floor((width - contentWidth) / 2));
  return <Text>{" ".repeat(leftPad)}{children}</Text>;
}
