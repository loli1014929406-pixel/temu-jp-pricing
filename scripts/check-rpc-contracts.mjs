import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(absolutePath, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [absolutePath] : [];
  }));
  return files.flat();
}

const sourceFiles = await listFiles(path.join(projectDir, "src"), [".ts", ".tsx"]);
const migrationFiles = await listFiles(path.join(projectDir, "supabase", "migrations"), [".sql"]);
const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
const migrationEntries = await Promise.all(
  migrationFiles.map(async (file) => ({ file, sql: await readFile(file, "utf8") })),
);
const migrations = migrationEntries.map((entry) => entry.sql).join("\n");

const rpcNames = Array.from(source.matchAll(/\.rpc\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g))
  .map((match) => match[1])
  .filter(Boolean);
const uniqueRpcNames = [...new Set(rpcNames)].sort();
const missing = uniqueRpcNames.filter((name) =>
  !new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i").test(migrations),
);
const contractErrors = [];
const latestFinanceMetrics = migrationEntries
  .filter((entry) => /create\s+or\s+replace\s+function\s+public\.get_finance_order_metrics\s*\(/i.test(entry.sql))
  .sort((left, right) => left.file.localeCompare(right.file))
  .at(-1);

if (
  !latestFinanceMetrics
  || !/partition\s+by\s+btrim\(base\.order_no\)/i.test(latestFinanceMetrics.sql)
  || /partition\s+by\s+base\.source_order_id/i.test(latestFinanceMetrics.sql)
) {
  contractErrors.push("Latest get_finance_order_metrics must attribute settlement revenue once per trimmed order_no.");
}

if (missing.length > 0 || contractErrors.length > 0) {
  if (missing.length > 0) {
    console.error(`Frontend RPC calls without a migration definition: ${missing.join(", ")}`);
  }
  contractErrors.forEach((message) => console.error(message));
  process.exitCode = 1;
} else {
  console.log(`Checked ${uniqueRpcNames.length} frontend RPC contracts against migrations.`);
}
