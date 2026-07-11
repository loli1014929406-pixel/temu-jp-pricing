import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(projectDir, "src");
const syncScriptPath = path.join(projectDir, "scripts", "sync-codex-data.mjs");

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(target);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
    }),
  );
  return files.flat();
}

function extractSyncTables(source) {
  const tablesBlock = source.match(/const\s+tables\s*=\s*\[([\s\S]*?)\];/);
  if (!tablesBlock) throw new Error("无法读取 sync-codex-data.mjs 的 tables 清单。");
  return new Set(
    Array.from(tablesBlock[1].matchAll(/"([a-z0-9_]+)"/g), (match) => match[1]),
  );
}

function extractSupabaseTables(source) {
  return Array.from(source.matchAll(/\.from\(\s*["']([a-z0-9_]+)["']\s*\)/g), (match) => match[1]);
}

const syncTables = extractSyncTables(await readFile(syncScriptPath, "utf8"));
const sourceFiles = await listSourceFiles(sourceDir);
const usedTables = new Set();

for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  extractSupabaseTables(source).forEach((table) => usedTables.add(table));
}

const missingTables = [...usedTables].filter((table) => !syncTables.has(table)).sort();
if (missingTables.length > 0) {
  console.error(`数据库快照缺少运行表：${missingTables.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `数据库覆盖检查通过：应用使用 ${usedTables.size} 张表，快照配置 ${syncTables.size} 张表。`,
  );
}
