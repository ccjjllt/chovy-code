import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chovyCacheDir, ensureHomeDirs } from "../fs/home.js";
import { logger } from "../logger/logger.js";

export interface MruData {
  items: Record<string, { count: number; lastUsedAt: number }>;
  v: 1;
}

const MRU_FILE = "palette-mru.json";

function getMruPath(): string {
  ensureHomeDirs();
  return join(chovyCacheDir(), MRU_FILE);
}

export function mruScore(count: number, lastUsedAt: number, now: number): number {
  const ageDays = (now - lastUsedAt) / 86_400_000;
  return count * Math.exp(-ageDays / 30);
}

export function readMru(): MruData {
  try {
    const path = getMruPath();
    const data = readFileSync(path, "utf-8");
    const parsed = JSON.parse(data) as Partial<MruData>;
    if (parsed.v === 1 && parsed.items) {
      return parsed as MruData;
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      logger.warn(`Failed to read MRU file: ${err.message}`);
    }
  }
  return { items: {}, v: 1 };
}

export function writeMru(data: MruData): void {
  try {
    const path = getMruPath();
    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, path);
  } catch (err: any) {
    logger.warn(`Failed to write MRU file: ${err.message}`);
  }
}

export function bumpMru(commandId: string, now: number = Date.now()): void {
  const data = readMru();
  const entry = data.items[commandId] ?? { count: 0, lastUsedAt: 0 };
  entry.count += 1;
  entry.lastUsedAt = now;
  data.items[commandId] = entry;
  writeMru(data);
}
