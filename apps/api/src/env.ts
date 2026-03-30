import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  API_PORT: z.coerce.number().default(3000),
  DATA_DIR: z.string().default("./data"),
  DATABASE_URL: z.string().optional(),
  API_KEY: z.string().optional(),
  PYTHON_WORKER_URL: z.string().url().default("http://127.0.0.1:8000"),
  MAX_UPLOAD_BYTES: z.coerce.number().default(52_428_800),
});

const parsed = schema.parse(process.env);

const dataDir = resolve(parsed.DATA_DIR);
mkdirSync(dataDir, { recursive: true });
mkdirSync(resolve(dataDir, "blobs"), { recursive: true });

const databaseUrl = parsed.DATABASE_URL ?? resolve(dataDir, "axion.db");

export const env = {
  ...parsed,
  DATA_DIR: dataDir,
  DATABASE_URL: databaseUrl,
};
