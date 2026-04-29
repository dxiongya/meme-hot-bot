import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

db.on("error", (err) => {
  console.error("[db] pool error", err);
});

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
