import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(projectDir, "supabase", "migrations");
const migrationNamePattern = /^\d{8}_[a-z0-9_]+\.sql$/;

const migrationFiles = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const errors = [];
const warnings = [];

for (const file of migrationFiles) {
  if (!migrationNamePattern.test(file)) {
    errors.push(`${file}: migration filename must use YYYYMMDD_snake_case.sql`);
  }

  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  const functionMatches = Array.from(
    sql.matchAll(/create\s+or\s+replace\s+function\s+([^\s(]+)/gi),
  );

  functionMatches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = functionMatches[index + 1]?.index ?? sql.length;
    const block = sql.slice(start, end);
    const functionName = match[1];

    const securityMessage = `${file}: ${functionName} must declare SECURITY INVOKER or SECURITY DEFINER`;
    if (!/security\s+(invoker|definer)/i.test(block)) {
      (file >= "20260710_" ? errors : warnings).push(securityMessage);
    }
    const searchPathMessage = `${file}: ${functionName} must pin search_path to public`;
    if (!/set\s+search_path\s*=\s*public/i.test(block)) {
      (file >= "20260710_" ? errors : warnings).push(searchPathMessage);
    }
    if (
      file >= "20260710_" &&
      !new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${functionName.replaceAll(".", "\\.")}`, "i").test(sql)
    ) {
      errors.push(`${file}: ${functionName} must revoke default PUBLIC execution`);
    }
  });

  if (/grant\s+all\s+on\s+table[\s\S]*?\s+to\s+anon\b/i.test(sql)) {
    warnings.push(`${file}: grants table access to anon; verify a later migration revokes it`);
  }
}

if (warnings.length > 0) {
  console.warn(warnings.map((warning) => `WARN ${warning}`).join("\n"));
}
if (errors.length > 0) {
  console.error(errors.map((error) => `ERROR ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${migrationFiles.length} migration files.`);
}
