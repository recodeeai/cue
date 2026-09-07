import { readFileSync } from "node:fs";

interface Threshold {
  lines: number;
  functions: number;
}

const thresholds: Record<string, Threshold> = {
  "src/lib/default-profile.ts": { lines: 90, functions: 100 },
  "src/lib/cwd-resolver.ts": { lines: 90, functions: 90 },
  "src/lib/profile-loader.ts": { lines: 80, functions: 80 },
  "src/lib/runtime-materializer.ts": { lines: 80, functions: 75 },
  // launch.ts still contains orchestration exercised by e2e tests outside this
  // focused run. This floor locks its current unit-tested surface while it is split.
  "src/commands/launch.ts": { lines: 18, functions: 75 },
};

const lcovPath = process.argv[2] ?? "coverage/critical/lcov.info";
const records = readFileSync(lcovPath, "utf8").split("end_of_record");
let failed = false;

for (const [file, minimum] of Object.entries(thresholds)) {
  const record = records.find((item) => item.includes(`SF:${file}\n`));
  if (!record) {
    console.error(`critical coverage: missing ${file}`);
    failed = true;
    continue;
  }

  const value = (key: string): number => Number(record.match(new RegExp(`^${key}:(\\d+)$`, "m"))?.[1] ?? 0);
  const lineTotal = value("LF");
  const lineHit = value("LH");
  const functionTotal = value("FNF");
  const functionHit = value("FNH");
  const lines = lineTotal === 0 ? 0 : (lineHit * 100) / lineTotal;
  const functions = functionTotal === 0 ? 0 : (functionHit * 100) / functionTotal;
  const ok = lines >= minimum.lines && functions >= minimum.functions;
  process.stdout.write(
    `${ok ? "✓" : "✗"} ${file}: lines ${lines.toFixed(1)}% (>=${minimum.lines}%), ` +
      `functions ${functions.toFixed(1)}% (>=${minimum.functions}%)\n`,
  );
  if (!ok) failed = true;
}

if (failed) process.exit(1);
