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
const migrations = (await Promise.all(migrationFiles.map((file) => readFile(file, "utf8")))).join("\n");

const rpcNames = Array.from(source.matchAll(/\.rpc\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g))
  .map((match) => match[1])
  .filter(Boolean);
const uniqueRpcNames = [...new Set(rpcNames)].sort();
const missing = uniqueRpcNames.filter((name) =>
  !new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i").test(migrations),
);

if (missing.length > 0) {
  console.error(`Frontend RPC calls without a migration definition: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${uniqueRpcNames.length} frontend RPC contracts against migrations.`);
}
