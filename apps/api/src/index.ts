import { buildApp } from "./app.js";
import { runMigrations } from "./db/client.js";
import { env } from "./env.js";
import { rootLogger } from "./log.js";

runMigrations();

const app = await buildApp();
const port = env.API_PORT;
try {
  await app.listen({ port, host: "0.0.0.0" });
  rootLogger.info({ event: "listen", port, data_dir: env.DATA_DIR });
} catch (e) {
  rootLogger.error(e);
  process.exit(1);
}
