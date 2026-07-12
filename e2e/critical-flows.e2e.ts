import { expect, test } from "@playwright/test";
import path from "node:path";

const email = process.env.E2E_USER_EMAIL;
const password = process.env.E2E_USER_PASSWORD;

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email ?? "");
  await page.getByLabel("密码").fill(password ?? "");
  await page.getByRole("button", { name: "安全登录" }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}

test("登录页只提供一个安全登录入口", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByText("账号登录")).toBeVisible();
  await expect(page.getByRole("button", { name: "安全登录" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toHaveCount(0);
});

test("已登录账号可以完成关键业务只读回归", async ({ page }) => {
  test.skip(!email || !password, "需要设置 E2E_USER_EMAIL 和 E2E_USER_PASSWORD");
  await signIn(page);

  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "订单管理", exact: true })).toBeVisible();
  await expect(page.getByText(/订单后端分页尚未初始化/)).toHaveCount(0);

  const search = page.getByPlaceholder("订单号 / 收货人 / 地址 / 物流");
  await search.fill("codex-e2e-no-match");
  await expect(page.getByText("暂无订单数据")).toBeVisible();
  await search.clear();
  await expect(page.getByText(/当前显示 \d+ 行，共 \d+ 行/)).toBeVisible();

  const pendingAssignment = page.getByRole("button", { name: /^待分配/ });
  await pendingAssignment.click();
  await expect(pendingAssignment).toHaveAttribute("aria-pressed", "true");

  const pageSize = page.getByLabel("每页显示数量");
  if (await pageSize.isVisible()) {
    await pageSize.selectOption("50");
    await expect(pageSize).toHaveValue("50");
  }

  const importInput = page.getByLabel("选择 Temu 订单文件");
  if (await importInput.count()) {
    await importInput.setInputFiles(
      path.join(process.cwd(), "e2e", "fixtures", "order-import-smoke.csv"),
    );
    await expect(page.getByText(/确认导入订单文件/)).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
  }

  await page.goto("/purchases/records");
  await expect(
    page.getByRole("heading", { name: "采购管理记录", exact: true, level: 1 }),
  ).toBeVisible();

  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "仓储库存", exact: true })).toBeVisible();

  await page.goto("/finance/settlement");
  await expect(page.getByRole("heading", { name: "结算与对账", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/加载财务订单失败|加载财务订单分页与汇总失败/)).toHaveCount(0);
  await page.getByRole("button", { name: "收入明细", exact: true }).click();
  await expect(page.getByText(/筛选后共 \d+ 单/)).toBeVisible();

  await page.goto("/finance/ledger");
  await expect(page.getByRole("heading", { name: "收支流水", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/加载收支流水失败/)).toHaveCount(0);
});
