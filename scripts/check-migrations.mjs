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
const sqlByFile = Object.fromEntries(
  await Promise.all(
    migrationFiles.map(async (file) => [
      file,
      await readFile(path.join(migrationsDir, file), "utf8"),
    ]),
  ),
);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const [fileIndex, file] of migrationFiles.entries()) {
  if (!migrationNamePattern.test(file)) {
    errors.push(`${file}: migration filename must use YYYYMMDD_snake_case.sql`);
  }

  const sql = sqlByFile[file];
  const laterSql = migrationFiles
    .slice(fileIndex + 1)
    .map((laterFile) => sqlByFile[laterFile])
    .join("\n");
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
    const laterSearchPathHardening = new RegExp(
      `alter\\s+function\\s+${escapeRegex(functionName)}\\s*\\([^;]*\\)\\s+set\\s+search_path\\s*=\\s*public`,
      "i",
    ).test(laterSql);
    if (!/set\s+search_path\s*=\s*public/i.test(block) && !laterSearchPathHardening) {
      (file >= "20260710_" ? errors : warnings).push(searchPathMessage);
    }
    if (
      file >= "20260710_" &&
      !new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${functionName.replaceAll(".", "\\.")}`, "i").test(sql)
    ) {
      errors.push(`${file}: ${functionName} must revoke default PUBLIC execution`);
    }
  });

  const anonGrantMatches = Array.from(
    sql.matchAll(/grant\s+all\s+on\s+table\s+([^\s;]+)\s+to\s+anon\b/gi),
  );
  anonGrantMatches.forEach((match) => {
    const tableName = match[1];
    const laterRevoke = new RegExp(
      `revoke\\s+all\\s+on\\s+table\\s+${escapeRegex(tableName)}\\s+from\\s+anon\\b`,
      "i",
    ).test(laterSql);
    if (!laterRevoke) {
      warnings.push(`${file}: grants ${tableName} access to anon without a later revoke`);
    }
  });
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
