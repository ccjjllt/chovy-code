
import { Chip } from "./Chip.js";

export function SwarmChip({ running, done }: { running: number; done: number }) {
  return <Chip label={`swarm: ${running}R/${done}D`} dim />;
}
