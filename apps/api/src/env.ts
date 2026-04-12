import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

function parseBooleanEnv(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

const schema = z.object({
  API_PORT: z.coerce.number().default(3000),
  DATA_DIR: z.string().default("./data"),
  DATABASE_URL: z.string().optional(),
  API_KEY: z.string().optional(),
  WEB_APP_URL: z.string().url().default("http://127.0.0.1:5173"),
  PYTHON_WORKER_URL: z.string().url().default("http://127.0.0.1:8000"),
  MAX_UPLOAD_BYTES: z.coerce.number().default(52_428_800),
  AUDIO_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  AUDIO_RETENTION_CONFIRM_TOKEN: z.string().optional(),
  PRIVACY_ADMIN_API_KEY: z.string().optional(),
  MODEL_PRICE_OVERRIDES_JSON: z.string().optional(),
  MALWARE_SCAN_ENABLED: z.string().optional(),
  MALWARE_SCAN_BIN: z.string().default("clamscan"),
  MALWARE_SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

const parsed = schema.parse(process.env);

const dataDir = resolve(parsed.DATA_DIR);
mkdirSync(dataDir, { recursive: true });
mkdirSync(resolve(dataDir, "blobs"), { recursive: true });

const databaseUrl = parsed.DATABASE_URL ?? resolve(dataDir, "axion.db");
const malwareScanEnabled = parseBooleanEnv("MALWARE_SCAN_ENABLED", parsed.MALWARE_SCAN_ENABLED, false);

export const env = {
  ...parsed,
  DATA_DIR: dataDir,
  DATABASE_URL: databaseUrl,
  MALWARE_SCAN_ENABLED: malwareScanEnabled,
};
