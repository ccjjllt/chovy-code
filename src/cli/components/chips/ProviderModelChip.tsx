
import { Chip } from "./Chip.js";

export function ProviderModelChip({ provider, model }: { provider: string; model: string }) {
  return <Chip label={`${provider}/${model}`} dim />;
}
