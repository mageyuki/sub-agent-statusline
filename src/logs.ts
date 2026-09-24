import { readFileSync, statSync } from "node:fs";
import { MAX_SYNC_LOG_READ_BYTES } from "./internal-policy.js";

function safeRead<T>(reader: () => T): T | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}

export function readOpenCodeLogFileIfSmall(path: string): string | undefined {
  const stats = safeRead(() => statSync(path));
  if (!stats?.isFile() || stats.size > MAX_SYNC_LOG_READ_BYTES) {
    return undefined;
  }
  return safeRead(() => readFileSync(path, "utf8"));
}
