import { expect, test } from "@playwright/test";

const replayUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";

test.beforeEach(async ({ page }) => {
  await page.goto(`${replayUrl}/decision/market-replay`);
});

test("刷新缓存状态后再次点击入口可以收起面板", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "行情缓存状态" });
  const panel = page.locator("#replay-cache-status-panel");

  await trigger.click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "刷新缓存状态" }).click();
  await trigger.click();

  await expect(panel).toBeHidden();
});

test("点击面板外或按 Esc 可以收起面板", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "行情缓存状态" });
  const panel = page.locator("#replay-cache-status-panel");

  await trigger.click();
  await page.mouse.click(20, 300);
  await expect(panel).toBeHidden();

  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
