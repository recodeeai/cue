import { readFile } from "node:fs/promises";
import { getPool } from "../lib/db.js";

const pool = getPool();
const db = await pool.connect();
try {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(184726391)");
  await db.query("CREATE TABLE IF NOT EXISTS cue_schema_migration (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const id of ["001-workspaces", "002-workspace-repositories"]) {
    if ((await db.query("SELECT id FROM cue_schema_migration WHERE id=$1", [id])).rowCount) continue;
    await db.query(await readFile(new URL(`../migrations/${id}.sql`, import.meta.url), "utf8"));
    await db.query("INSERT INTO cue_schema_migration(id) VALUES($1)", [id]);
    console.log(`Applied ${id}`);
  }
  await db.query("COMMIT");
} catch {
  await db.query("ROLLBACK");
  console.error("Workspace migration failed; transaction rolled back. Check database permissions and existing schema.");
  process.exitCode = 1;
} finally { db.release(); await pool.end(); }
