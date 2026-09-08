import { expect, test } from "@playwright/test";

const replayUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";

test("起始页提供可配置的盲测开局，而不再提供战法专项入口", async ({ page }) => {
  await page.goto(`${replayUrl}/decision/market-replay`);

  await expect(
    page.getByRole("heading", { name: "用未知行情验证一条交易规则" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "这次怎么练？" })).toBeVisible();
  await expect(page.getByRole("button", { name: /日线演练/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始日线盲测" })).toBeVisible();
  await page.getByRole("button", { name: /日内模拟/ }).click();
  await expect(page.getByRole("button", { name: "开始日内模拟" })).toBeVisible();
  await expect(page.getByText("调整资金与成本", { exact: true })).toBeVisible();
  await page.getByText("调整资金与成本", { exact: true }).click();
  await expect(page.getByText("资金与成本", { exact: true })).toBeVisible();
  const modal = page.getByRole("dialog", { name: "资金与成本" });
  const closeButton = modal.getByRole("button", { name: "关闭弹窗" });
  await expect(closeButton).toBeVisible();
  await expect(modal.getByLabel("滑点（bps）")).toHaveCSS("border-radius", "16px");
  const bounds = await modal.boundingBox();
  expect(bounds.width).toBeLessThanOrEqual(420);
  expect(Math.abs(bounds.x + bounds.width / 2 - page.viewportSize().width / 2)).toBeLessThan(2);
  await modal.getByLabel("初始资金").fill("30000");
  await modal.getByLabel("滑点（bps）").fill("8");
  await closeButton.click();
  await expect(modal).toBeHidden();
  await page.getByText("调整资金与成本", { exact: true }).click();
  await expect(modal.getByLabel("初始资金")).toHaveValue("30000");
  await expect(modal.getByLabel("滑点（bps）")).toHaveValue("8");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page.locator(".replay-setup__configuration-trigger .lucide-settings-2")).toHaveCount(1);
  await expect(page.getByText("交付闭环", { exact: true })).toHaveCount(0);
  await expect(page.getByText("战法专项", { exact: true })).toHaveCount(0);
  await expect(page.getByText("专项战法", { exact: true })).toHaveCount(0);
});

test("新演练默认使用非零滑点", async ({ page }) => {
  await page.goto(`${replayUrl}/decision/market-replay`);
  await page.getByText("调整资金与成本", { exact: true }).click();

  await expect(page.getByLabel("滑点（bps）")).toBeVisible();
  await expect(page.getByLabel("滑点（bps）")).toHaveValue("5");
});
