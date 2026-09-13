import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const landingUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5180";

function relativeLuminance([red, green, blue]) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(color) {
  return color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
}

async function cssColor(page, token) {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

test("展示页在桌面和窄屏保留产品图比例且没有横向溢出", async ({ page }) => {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${landingUrl}/landing/`);
    await page.locator(".quickstart summary").click();

    const dimensions = await page.locator(".evidence-step img").evaluateAll((elements) => ({
      images: elements.map((element) => ({
        naturalRatio: element.naturalWidth / element.naturalHeight,
        renderedRatio: element.getBoundingClientRect().width / element.getBoundingClientRect().height,
        objectFit: getComputedStyle(element).objectFit,
      })),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(dimensions.images).toHaveLength(6);
    for (const image of dimensions.images) {
      expect(image.naturalRatio).toBeGreaterThan(0);
      expect(image.renderedRatio).toBeGreaterThan(0);
      expect(image.objectFit).toBe("cover");
    }
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expect(page.locator(".hero-market")).toBeVisible();
  }
});

test("展示页的辅助文本、焦点环与语义结构保持可访问", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${landingUrl}/landing/`);

  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator(".hero-market")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".hero-market")).toHaveCSS("pointer-events", "none");
  await expect(page.locator("h1")).toHaveCSS("text-wrap", "balance");
  const headingLines = await page.locator("h1").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      widths: [...range.getClientRects()].map((rect) => rect.width),
    };
  });
  expect(headingLines.widths.at(-1)).toBeGreaterThanOrEqual(headingLines.fontSize * 3);

  const [subtleText, inverseSubtleText, pageSurface, footerSurface, focusOnLight, focusOnDark, darkSurface] = await Promise.all([
    cssColor(page, "--text-subtle"),
    cssColor(page, "--text-inverse-subtle"),
    cssColor(page, "--surface-page"),
    cssColor(page, "--surface-footer"),
    cssColor(page, "--focus-ring-on-light"),
    cssColor(page, "--focus-ring-on-dark"),
    cssColor(page, "--surface-dark"),
  ]);

  expect(await page.locator(".evidence-figure figcaption").first().evaluate((element) => getComputedStyle(element).color)).toBe(subtleText);
  expect(await page.locator(".invite p").evaluate((element) => getComputedStyle(element).color)).toBe(inverseSubtleText);
  expect(await page.locator("footer").evaluate((element) => getComputedStyle(element).color)).toBe(inverseSubtleText);
  expect(contrastRatio(parseRgb(subtleText), parseRgb(pageSurface))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(parseRgb(inverseSubtleText), parseRgb(darkSurface))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(parseRgb(inverseSubtleText), parseRgb(footerSurface))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(parseRgb(focusOnLight), parseRgb(pageSurface))).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(parseRgb(focusOnDark), parseRgb(darkSurface))).toBeGreaterThanOrEqual(3);

  await page.locator(".nav-install").focus();
  await expect(page.locator(".nav-install")).toBeFocused();
  await expect(page.locator(".nav-install")).toHaveCSS("outline-color", focusOnLight);
  await expect(page.locator(".nav-install")).toHaveCSS("outline-width", "3px");
  await page.locator(".invite .button:not(.primary)").first().focus();
  await expect(page.locator(".invite .button:not(.primary)").first()).toBeFocused();
  await expect(page.locator(".invite .button:not(.primary)").first()).toHaveCSS("outline-color", focusOnDark);
  await expect(page.locator(".invite .button:not(.primary)").first()).toHaveCSS("outline-width", "3px");
  const quickstartSummary = page.locator(".quickstart summary");
  await quickstartSummary.focus();
  await expect(quickstartSummary).toBeFocused();
  await quickstartSummary.press("Enter");
  await expect(page.locator(".quickstart")).toHaveAttribute("open", "");
  const firstCopyButton = page.getByRole("button", { name: "复制下载项目命令" });
  await firstCopyButton.focus();
  await expect(firstCopyButton).toBeFocused();
  await expect(firstCopyButton).toHaveCSS("outline-color", focusOnDark);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${landingUrl}/landing/`);
  const keyboardTargets = await page.locator("a[href], summary, button:not([disabled]), pre[tabindex='0']").evaluateAll((elements) => elements
    .filter((element) => element.checkVisibility() && element.getClientRects().length > 0)
    .map((element) => `${element.tagName}:${element.getAttribute("href") ?? element.getAttribute("aria-label") ?? element.textContent.trim()}`));
  const reachedTargets = new Set();
  for (let index = 0; index < keyboardTargets.length; index += 1) {
    await page.keyboard.press("Tab");
    const activeTarget = await page.evaluate(() => {
      const element = document.activeElement;
      return element?.matches("a[href], summary, button:not([disabled]), pre[tabindex='0']")
        ? `${element.tagName}:${element.getAttribute("href") ?? element.getAttribute("aria-label") ?? element.textContent.trim()}`
        : null;
    });
    if (activeTarget) reachedTargets.add(activeTarget);
  }
  expect(reachedTargets).toEqual(new Set(keyboardTargets));
});

test("首屏行情遮罩在桌面端跟随鼠标并在离开后复位", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${landingUrl}/landing/`);

  const hero = page.locator(".hero");
  const bounds = await hero.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.24, bounds.y + bounds.height * 0.5);
  await expect.poll(() => hero.evaluate((element) => Number.parseFloat(element.style.getPropertyValue("--reveal-x")))).toBeCloseTo(24, 0);
  await expect(hero).toHaveClass(/is-tracking/);
  await page.mouse.move(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.5);
  await expect.poll(() => hero.evaluate((element) => Number.parseFloat(element.style.getPropertyValue("--reveal-x")))).toBeCloseTo(82, 0);
  await page.mouse.move(0, 0);
  await expect(hero).not.toHaveClass(/is-tracking/);
  expect(await hero.evaluate((element) => element.style.getPropertyValue("--reveal-x"))).toBe("");
});

test("首屏行情示意在减少动态偏好下保持固定", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${landingUrl}/landing/`);

  const hero = page.locator(".hero");
  const bounds = await hero.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.24, bounds.y + bounds.height * 0.5);
  expect(await hero.evaluate((element) => element.style.getPropertyValue("--reveal-x"))).toBe("");
  await expect(page.locator(".hero-market-mask")).toHaveCSS("transition-duration", "0s");
});

test("展示页清楚区分离线与真实行情路径，并展示决策证据链", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: landingUrl });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${landingUrl}/landing/`);

  await expect(page.getByRole("link", { name: "先看新手练习步骤" }).first()).toHaveAttribute("href", "#offline-demo");
  await expect(page.getByRole("link", { name: "查看真实行情要求" }).first()).toHaveAttribute("href", "#real-market");
  await expect(page.getByRole("heading", { name: "第一次使用，先选左边" })).toBeVisible();
  await expect(page.locator(".hero-market-mask")).toBeVisible();
  await expect(page.locator(".hero-market-cursor")).toBeVisible();
  await expect(page.locator("#offline-demo").getByRole("heading", { name: "先用示例数据练一遍" })).toBeVisible();
  await expect(page.locator("#real-market").getByRole("heading", { name: "再用真实历史行情练习" })).toBeVisible();
  await expect(page.getByText("安装项目时仍需联网下载依赖；开始练习后不连接行情服务。", { exact: true })).toBeVisible();
  await expect(page.getByText("建议先完成一次示例数据练习，再使用真实历史行情。", { exact: true })).toBeVisible();

  const quickstart = page.locator(".quickstart");
  await expect(quickstart).not.toHaveAttribute("open", "");
  await expect(quickstart.locator(".quickstart-body")).toBeHidden();
  await expect(quickstart.locator("summary")).toContainText("安装并启动");
  await expect(quickstart.locator("summary")).toHaveCSS("cursor", "pointer");
  await expect(quickstart.locator("summary")).toHaveAccessibleName("安装并启动 准备在本机使用时，展开查看三步命令。");
  expect(await quickstart.locator(".disclosure-icon").evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("1");
  await quickstart.locator("summary").click();
  await expect(quickstart).toHaveAttribute("open", "");
  await expect(quickstart.locator(".quickstart-body")).toBeVisible();
  await expect.poll(() => quickstart.locator(".disclosure-icon").evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("0");
  await expect(quickstart).toContainText("git clone https://github.com/DaNN-55/InvestFlow-Replay.git");
  await expect(quickstart).toContainText("cd InvestFlow-Replay");
  await expect(quickstart).toContainText("./install.sh");
  await expect(quickstart).toContainText("# 示例数据（推荐）");
  await expect(quickstart).toContainText("./run-demo.sh");
  await expect(quickstart).toContainText("# 真实历史行情");
  await expect(quickstart).toContainText("./run.sh");
  await expect(quickstart).toContainText("127.0.0.1:5280/decision/market-replay");
  await expect(quickstart).toContainText("127.0.0.1:5180/decision/market-replay");
  await expect(quickstart.getByRole("button", { name: /^复制/ })).toHaveCount(3);
  const copyDownload = quickstart.getByRole("button", { name: "复制下载项目命令" });
  await expect(copyDownload.locator("svg.copy-icon")).toBeVisible();
  await copyDownload.click();
  await expect(copyDownload).toHaveClass(/is-copied/);
  await expect(copyDownload).toHaveAttribute("aria-label", "已复制下载项目命令");
  await expect(quickstart.locator(".copy-status")).toContainText("已复制下载项目命令");

  const evidence = page.locator(".evidence-step img");
  await expect(evidence).toHaveCount(6);
  const expectedEvidence = [
    "/landing-replay-setup.png",
    "/landing-replay-settings.png",
    "/landing-replay-decision.png",
    "/landing-replay-review-score.png",
    "/landing-replay-review-blind.png",
    "/landing-replay-review-post.png",
  ];
  for (const [index, src] of expectedEvidence.entries()) {
    await expect(evidence.nth(index)).toHaveAttribute("src", src);
  }
  for (const image of await evidence.all()) {
    await expect(image).toHaveAttribute("alt", /.+/);
  }

  const boundaries = page.locator("#boundaries");
  await expect(boundaries.locator(".version-strip")).toContainText("版本：v0.1.0-alpha.1");
  await expect(boundaries.locator(".version-strip")).toContainText("平台：仅 macOS 已完成本地验收；其他系统待验证。");
  await expect(boundaries.locator(".version-strip")).toContainText("许可：Apache-2.0");
  await expect(boundaries.locator(".boundary-grid")).toContainText("不连接证券账户，不真实下单，不承诺收益。");
});

test("Pages 工作流复制展示页引用的证据素材", async () => {
  const workflowUrl = new URL("../../../.github/workflows/pages.yml", import.meta.url);
  const workflow = await readFile(workflowUrl, "utf8");

  for (const asset of [
    "landing-replay-setup.png",
    "landing-replay-settings.png",
    "landing-replay-decision.png",
    "landing-replay-review-score.png",
    "landing-replay-review-blind.png",
    "landing-replay-review-post.png",
  ]) {
    expect(workflow).toContain(`web/public/${asset}`);
    expect(workflow).toContain(`src="/${asset}"`);
    expect(workflow).toContain(`src="./${asset}"`);
  }
});
