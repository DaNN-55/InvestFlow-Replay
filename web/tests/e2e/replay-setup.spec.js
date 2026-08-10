import { expect, test } from "@playwright/test";

const replayUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";

test("新开训练不再提供战法专项入口", async ({ page }) => {
  await page.goto(`${replayUrl}/decision/market-replay`);

  await expect(page.getByRole("heading", { name: "用未知行情验证一条交易规则" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "一轮训练，完成一次规则验证" })).toBeVisible();
  await expect(page.getByText("战法专项", { exact: true })).toHaveCount(0);
  await expect(page.getByText("专项战法", { exact: true })).toHaveCount(0);
});
