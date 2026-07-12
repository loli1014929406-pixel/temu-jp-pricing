import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(serious, serious.map((item) => `${item.id}: ${item.help}`).join("\n")).toEqual([]);
}

test("登录和密码恢复页面无严重 Axe 问题", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /Temu 日本站/ })).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "找回密码" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("已登录主页面无严重 Axe 问题", async ({ page }) => {
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  test.skip(!email || !password, "需要 E2E_USER_EMAIL 和 E2E_USER_PASSWORD");
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email!);
  await page.getByLabel("密码").fill(password!);
  await page.getByRole("button", { name: "安全登录" }).click();
  await page.waitForURL(/\/orders|\/products/);
  await expectNoSeriousViolations(page);
});
