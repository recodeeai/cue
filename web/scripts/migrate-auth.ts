import { getMigrations } from "better-auth/db/migration";
import { auth } from "../lib/auth.js";

// Use the application's exact BetterAuth version. An independently versioned
// CLI can create a newer, incompatible schema (for example account.issuer).
try {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  console.log("Auth schema matches the installed BetterAuth runtime.");
  process.exit(0);
} catch {
  console.error("Auth migration failed. Check database access and schema compatibility.");
  process.exit(1);
}
