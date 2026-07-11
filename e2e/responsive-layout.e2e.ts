import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_USER_EMAIL;
const password = process.env.E2E_USER_PASSWORD;
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
] as const;

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email ?? "");
  await page.getByLabel("密码").fill(password ?? "");
  await page.getByRole("button", { name: "安全登录" }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}

for (const viewport of viewports) {
  test(`登录页 ${viewport.name} 视觉基线`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.evaluate(() => document.fonts.ready);

    await expect(page.getByText("账号登录")).toBeVisible();
    await expectNoPageOverflow(page);
    await expect(page).toHaveScreenshot(`login-${viewport.name}.png`, {
      fullPage: true,
    });
  });

  test(`核心业务页 ${viewport.name} 响应式布局`, async ({ page }, testInfo) => {
    test.skip(!email || !password, "需要设置 E2E_USER_EMAIL 和 E2E_USER_PASSWORD");
    await page.setViewportSize(viewport);
    await signIn(page);

    for (const route of [
      { path: "/orders", heading: "订单管理", key: "orders" },
      { path: "/purchases/records", heading: "采购管理记录", key: "purchases" },
      { path: "/inventory", heading: "仓储库存", key: "inventory" },
      { path: "/finance/settlement", heading: "结算与对账", key: "settlement" },
    ]) {
      await page.goto(route.path);
      await expect(
        page.getByRole("heading", { name: route.heading, exact: true, level: 1 }),
      ).toBeVisible();
      await expectNoPageOverflow(page);
      await testInfo.attach(`${route.key}-${viewport.name}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
  });
}
