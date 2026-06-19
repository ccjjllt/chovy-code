import { saveConfigPatch } from "../config/index.js";

export function persistTheme(name: string): void {
  saveConfigPatch({ theme: { name } });
}
