import { expect, test } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";
const playbookId = "playbook-ui-test";
const currentVersion = {
  id: "playbook-version-2",
  playbookId,
  versionNumber: 2,
  content: "当前规则正文",
  changeSummary: "当前版本",
  createdAt: "2026-08-07T09:00:00.000Z",
  canDelete: false,
  deletionBlockReason: "current",
  referenceCount: 0,
};
const historicalVersion = {
  id: "playbook-version-1",
  playbookId,
  versionNumber: 1,
  content: "历史规则正文",
  changeSummary: "首个版本",
  createdAt: "2026-08-06T09:00:00.000Z",
  canDelete: true,
  deletionBlockReason: null,
  referenceCount: 0,
};

async function openPlaybookVersionMenu(page, versionNumber) {
  await page.locator(`summary[aria-label="v${versionNumber} 版本操作"]`).click();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/quant/decision/trade-records") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === "/api/quant/decision/execution-settings") {
      await route.fulfill({ json: {} });
      return;
    }
    if (url.pathname === "/api/quant/replay/sessions") {
      await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } });
      return;
    }
    if (url.pathname === "/api/quant/replay/playbooks") {
      await route.fulfill({
        json: {
          items: [{
            id: playbookId,
            name: "测试战法",
            currentVersion,
            pendingCandidateCount: 0,
          }],
        },
      });
      return;
    }
    if (url.pathname === `/api/quant/replay/playbooks/${playbookId}`) {
      await route.fulfill({
        json: {
          playbook: {
            id: playbookId,
            name: "测试战法",
            currentVersionId: currentVersion.id,
            currentVersion,
          },
          versions: [currentVersion, historicalVersion],
          candidates: [],
        },
      });
      return;
    }
    if (
      url.pathname === `/api/quant/replay/playbooks/${playbookId}/versions/${historicalVersion.id}`
      && route.request().method() === "DELETE"
    ) {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ json: {} });
  });
});

test("战法库是独立一级标签且历史演练不再嵌套标签", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records`);

  const primaryTabs = page.getByRole("navigation", { name: "交易追踪分类" });
  await expect(primaryTabs.getByRole("button", { name: "实盘与模拟", exact: true })).toBeVisible();
  await expect(primaryTabs.getByRole("button", { name: "历史演练", exact: true })).toBeVisible();
  await expect(primaryTabs.getByRole("button", { name: "战法库", exact: true })).toBeVisible();

  await primaryTabs.getByRole("button", { name: "历史演练", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "历史演练内容" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "历史演练", exact: true })).toBeVisible();

  await primaryTabs.getByRole("button", { name: "战法库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "测试战法", exact: true })).toBeVisible();
});

test("历史版本可以带入正文创建新版本并经过确认后删除", async ({ page }) => {
  await page.goto(`${baseUrl}/decision/trade-records`);
  await page.getByRole("navigation", { name: "交易追踪分类" })
    .getByRole("button", { name: "战法库", exact: true })
    .click();

  await openPlaybookVersionMenu(page, historicalVersion.versionNumber);
  await page.getByRole("button", { name: "基于 v1 修改", exact: true }).click();
  const versionForm = page.getByRole("form", { name: "基于 v1 创建新版本" });
  await expect(
    versionForm.getByRole("textbox", { name: /完整新正文/u }),
  ).toHaveValue("历史规则正文");
  await versionForm.getByRole("button", { name: "取消", exact: true }).click();

  await openPlaybookVersionMenu(page, historicalVersion.versionNumber);
  await page.getByRole("button", { name: "删除 v1", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "删除战法历史版本" });
  await expect(confirm).toContainText("v1");
  const deleteRequest = page.waitForRequest((request) =>
    request.method() === "DELETE"
      && new URL(request.url()).pathname
        === `/api/quant/replay/playbooks/${playbookId}/versions/${historicalVersion.id}`,
  );
  await confirm.getByRole("button", { name: "删除版本", exact: true }).click();
  await deleteRequest;
});
