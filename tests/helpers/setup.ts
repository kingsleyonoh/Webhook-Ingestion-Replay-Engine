import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env for test runs — provides DATABASE_URL, REDIS_URL, etc.
config({ path: resolve(import.meta.dirname, "../../.env") });
