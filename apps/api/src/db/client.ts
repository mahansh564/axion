import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as schema from "./schema.js";
import { env } from "../env.js";

const sqlite = new Database(env.DATABASE_URL);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(): void {
  migrate(db, { migrationsFolder: join(__dirname, "../../drizzle") });
}
