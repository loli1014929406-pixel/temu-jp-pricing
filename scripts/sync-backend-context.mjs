import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const localDataDir = path.join(projectDir, "local-data");
const snapshotFile = path.join(localDataDir, "codex-supabase-data.json");
const rulesFile = path.join(localDataDir, "calculation-rules.json");
const backendContextFile = path.join(localDataDir, "backend-context.json");
const schemaFile = path.join(projectDir, "supabase", "schema.sql");
const backendDir = process.env.TEMU_BACKEND_PROJECT_DIR
  ? path.resolve(process.env.TEMU_BACKEND_PROJECT_DIR)
  : path.resolve(projectDir, "..", "temu_japan_semi_managed_backend");
const backendDataDir = path.join(backendDir, "data");

const appUrl = process.env.TEMU_PRICING_APP_URL || "http://127.0.0.1:5173/";

function runNodeScript(scriptRelativePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectDir, scriptRelativePath)], {
      cwd: projectDir,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptRelativePath} exited with code ${code}`));
      }
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readSourceFile(relativePath) {
  const absolutePath = path.join(projectDir, relativePath);
  const content = await readFile(absolutePath, "utf8");
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: sha256(content),
    content,
  };
}

async function buildCalculationRules(snapshot) {
  const sourceFiles = await Promise.all(
    [
      "src/lib/defaults.ts",
      "src/utils/pricing.ts",
      "src/utils/profit-calculation.ts",
      "src/utils/test-shipping.ts",
      "src/pages/promotion-recommendations-page.tsx",
      "src/types.ts",
    ].map(readSourceFile),
  );
  const schema = await readFile(schemaFile, "utf8");
  const profitSource = sourceFiles.find((file) =>
    file.path.endsWith("profit-calculation.ts"),
  )?.content ?? "";
  const profitVersion =
    profitSource.match(/PROFIT_CALCULATION_VERSION\s*=\s*(\d+)/)?.[1] ?? null;

  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    source_application: {
      name: "temu-jp-pricing-main",
      project_path: projectDir,
      app_url: appUrl,
    },
    database_snapshot: {
      file_name: "codex-supabase-data.json",
      exported_at: snapshot.exported_at,
      auth_mode: snapshot.auth_mode,
      user: snapshot.user,
      summary: snapshot.summary,
      skipped_tables: snapshot.skipped_tables ?? [],
    },
    rule_groups: [
      {
        id: "declaration_pricing",
        source_file: "src/utils/pricing.ts",
        description: "商品申报价、采购成本、头程/尾程物流成本和目标利润率计算。",
        formulas: [
          "purchaseCostRmb = sum(item.purchase_price_rmb * item.quantity)",
          "purchaseShippingRmb = sum(ceil(item_weight_g * quantity / 500) * purchase_shipping_fee_per_500g_rmb)",
          "subsidyRmb = temu_shipping_subsidy_jpy * exchange_rate_rmb_per_jpy",
          "sfCostRmb = sf_first_price_rmb + max(packageWeightKg - sf_first_weight_kg, 0) * sf_extra_price_per_kg_rmb",
          "planA = huaianAirCostRmb + osakaLastmileRmb",
          "planB = huaianAirCostRmb + fukuokaLastmileRmb",
          "planC = ocsCostRmb * (1 + ocs_tariff_rate) + osakaLastmileRmb",
          "planD = ocsCostRmb * (1 + ocs_tariff_rate) + fukuokaLastmileRmb",
          "logisticsCostRmb = max(planA, planB, planC, planD)",
          "temuDeclarationPriceRmb = totalCostRmb / (1 - target_profit_rate) - subsidyRmb",
        ],
      },
      {
        id: "profit_projection",
        source_file: "src/utils/profit-calculation.ts",
        version: profitVersion,
        description: "最终销售价、广告费、广告后利润率和各物流方案利润测算。",
        formulas: [
          "discountedSalePriceRmb = temuPriceRmb * trafficDiscountRate * activityDiscountRate - couponDiscountRate",
          "subsidyRmb only applies when the discounted JPY price is at or above the Temu subsidy threshold",
          "realizedRevenueRmb = discountedSalePriceRmb + effectiveSubsidyRmb",
          "profitRmb = realizedRevenueRmb - purchaseCostRmb - purchaseShippingRmb - packagingCostRmb - sfCostRmb - logisticsCostRmb - adFeeRmb",
          "maxAdSpendRmb = realizedRevenueRmb * (1 - target_post_ad_profit_rate) - totalCostRmb",
        ],
      },
      {
        id: "test_shipping",
        source_file: "src/utils/test-shipping.ts",
        description: "直发 OCS 3cm 和 OCS 小包物流方案判断。",
      },
      {
        id: "promotion_recommendations",
        source_file: "src/pages/promotion-recommendations-page.tsx",
        description: "按核价、利润、广告空间、活动折扣、券额和流量加速让价生成保守运营建议。",
      },
    ],
    source_files: sourceFiles,
    database_schema: {
      file_name: "supabase-schema.sql",
      sha256: sha256(schema),
      content: schema,
    },
  };
}

async function main() {
  await mkdir(localDataDir, { recursive: true });
  await runNodeScript("scripts/sync-codex-data.mjs");

  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  const calculationRules = await buildCalculationRules(snapshot);
  await writeFile(rulesFile, `${JSON.stringify(calculationRules, null, 2)}\n`, "utf8");

  const backendContext = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    source_application: {
      name: "temu-jp-pricing-main",
      project_path: projectDir,
      app_url: appUrl,
    },
    backend_project: {
      path: backendDir,
    },
    files: {
      database_snapshot: "data/codex-supabase-data.json",
      calculation_rules: "data/calculation-rules.json",
      supabase_schema: "data/supabase-schema.sql",
    },
    snapshot_summary: snapshot.summary,
    auth_mode: snapshot.auth_mode,
    skipped_tables: snapshot.skipped_tables ?? [],
  };
  await writeFile(backendContextFile, `${JSON.stringify(backendContext, null, 2)}\n`, "utf8");

  await mkdir(backendDataDir, { recursive: true });
  await copyFile(snapshotFile, path.join(backendDataDir, "codex-supabase-data.json"));
  await copyFile(rulesFile, path.join(backendDataDir, "calculation-rules.json"));
  await copyFile(backendContextFile, path.join(backendDataDir, "backend-context.json"));
  await copyFile(schemaFile, path.join(backendDataDir, "supabase-schema.sql"));

  console.log(`已写入后端数据目录：${backendDataDir}`);
  console.log("后端可读取：backend-context.json、codex-supabase-data.json、calculation-rules.json、supabase-schema.sql");
}

await main();
