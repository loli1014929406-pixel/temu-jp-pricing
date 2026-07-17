import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(projectDir, "supabase", "migrations");
const migrationNamePattern = /^\d{14}_[a-z0-9_]+\.sql$/;
const strictMigrationCutoff = "20260710000000_";

const migrationFiles = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const errors = [];
const warnings = [];
const activeIndexes = new Map();
const pinnedSearchPathPattern =
  /set\s+search_path\s*=\s*(?:''|(?![^;\r\n]*\$user)[a-z_][\w$]*(?:\s*,\s*[a-z_][\w$]*)*)/i;
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

function normalizeIndexName(value) {
  return value.toLowerCase().replaceAll('"', '').split('.').at(-1);
}

for (const [fileIndex, file] of migrationFiles.entries()) {
  if (!migrationNamePattern.test(file)) {
    errors.push(`${file}: migration filename must use YYYYMMDDHHMMSS_snake_case.sql`);
  }

  const sql = sqlByFile[file];

  for (const match of sql.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?([^\s;]+)/gi)) {
    activeIndexes.delete(normalizeIndexName(match[1]));
  }
  for (const match of sql.matchAll(
    /create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([^\s;]+)\s+([\s\S]*?);/gi,
  )) {
    const name = normalizeIndexName(match[2]);
    const definition = `${match[1] ? "unique " : ""}${match[3]}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    activeIndexes.set(name, { definition, file });
  }
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
      (file >= strictMigrationCutoff ? errors : warnings).push(securityMessage);
    }
    const searchPathMessage = `${file}: ${functionName} must pin search_path to explicit schemas`;
    const laterSearchPathHardening = new RegExp(
      `alter\\s+function\\s+${escapeRegex(functionName)}\\s*\\([^;]*\\)\\s+set\\s+search_path\\s*=\\s*(?![^;\\r\\n]*\\$user)[a-z_][\\w$]*(?:\\s*,\\s*[a-z_][\\w$]*)*`,
      "i",
    ).test(laterSql);
    if (!pinnedSearchPathPattern.test(block) && !laterSearchPathHardening) {
      (file >= strictMigrationCutoff ? errors : warnings).push(searchPathMessage);
    }
    if (
      file >= strictMigrationCutoff &&
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

const indexesByDefinition = new Map();
for (const [name, index] of activeIndexes) {
  const group = indexesByDefinition.get(index.definition) ?? [];
  group.push({ name, file: index.file });
  indexesByDefinition.set(index.definition, group);
}
for (const indexes of indexesByDefinition.values()) {
  if (indexes.length < 2) continue;
  const message = `duplicate index definitions: ${indexes
    .map((index) => `${index.name} (${index.file})`)
    .join(", ")}`;
  errors.push(message);
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
