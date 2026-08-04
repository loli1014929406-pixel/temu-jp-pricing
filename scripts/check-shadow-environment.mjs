import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/authenticated-client.mjs";
import { assertShadowEnvironment } from "./lib/shadow-environment.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = await loadProjectEnv(projectDir);
const result = assertShadowEnvironment(env);

console.log(`影子环境检查通过：${result.shadowRef}（生产：${result.productionRef}）。`);
