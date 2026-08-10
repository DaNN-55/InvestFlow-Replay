import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const requireFromWeb = createRequire(join(projectDir, "web/package.json"));
const { chromium } = requireFromWeb("@playwright/test");

const baseUrl = "http://127.0.0.1:5280";
const outputPath = resolve(
  process.env.INVESTFLOW_DEMO_VIDEO ??
    join(projectDir, "portfolio-evidence/video/InvestFlow-Replay-offline-demo.mp4"),
);
const tempDir = mkdtempSync(join(tmpdir(), "investflow-demo-video-"));
const timeScale = Number(process.env.INVESTFLOW_DEMO_TIME_SCALE ?? 1);

if (!Number.isFinite(timeScale) || timeScale <= 0) {
  throw new Error("INVESTFLOW_DEMO_TIME_SCALE 必须是大于 0 的数字。");
}

const wait = (milliseconds) => new Promise((resolveWait) => {
  setTimeout(resolveWait, milliseconds);
});

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：${response.status}`);
  }
  return payload;
}

async function caption(page, title, detail, milliseconds = 8000) {
  await page.evaluate(({ titleText, detailText }) => {
    let overlay = document.querySelector("#portfolio-demo-caption");
    if (!overlay) {
      overlay = document.createElement("section");
      overlay.id = "portfolio-demo-caption";
      overlay.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:28px",
        "z-index:2147483647",
        "width:min(780px,calc(100vw - 48px))",
        "transform:translateX(-50%)",
        "padding:16px 20px",
        "border:1px solid rgba(255,255,255,.18)",
        "border-radius:14px",
        "background:rgba(13,19,32,.92)",
        "box-shadow:0 16px 50px rgba(0,0,0,.35)",
        "color:#f8fafc",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif",
        "pointer-events:none",
      ].join(";");
      overlay.innerHTML = "<strong></strong><p></p>";
      const heading = overlay.querySelector("strong");
      const paragraph = overlay.querySelector("p");
      heading.style.cssText = "display:block;font-size:20px;line-height:1.35";
      paragraph.style.cssText = "margin:6px 0 0;color:#cbd5e1;font-size:15px;line-height:1.5";
      document.body.appendChild(overlay);
    }
    overlay.querySelector("strong").textContent = titleText;
    overlay.querySelector("p").textContent = detailText;
  }, { titleText: title, detailText: detail });
  await wait(Math.max(1, Math.round(milliseconds * timeScale)));
}

async function clearCaption(page) {
  await page.evaluate(() => document.querySelector("#portfolio-demo-caption")?.remove());
}

async function main() {
  const runtime = await requestJson("/api/quant/replay/runtime");
  if (
    runtime.demoMode !== true ||
    runtime.marketProvider !== "fixture" ||
    runtime.storageIsolation !== "project-demo-storage"
  ) {
    throw new Error("拒绝录制：服务未同时启用 fixture 与项目内 .demo-storage 隔离。");
  }
  const health = await requestJson("/api/quant/replay/benchmarks");
  if (health.provider !== "fixture") {
    throw new Error("拒绝录制：当前不是 fixture Demo 服务。");
  }
  const history = await requestJson("/api/quant/replay/sessions?page=1&pageSize=1");
  if (Number(history.total ?? history.items?.length ?? 0) !== 0) {
    throw new Error("拒绝录制：Demo 已有演练记录，请先运行 ./stop-demo.sh && ./reset-demo.sh && ./run-demo.sh。");
  }
  const existingPlaybooks = await requestJson("/api/quant/replay/playbooks");
  if (existingPlaybooks.items?.some((item) => item.name === "趋势确认规则")) {
    throw new Error("拒绝录制：检测到上次录制残留，请先重置 Demo 数据。");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    recordVideo: { dir: tempDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const video = page.video();

  try {
    await requestJson("/api/quant/replay/playbooks", {
      method: "POST",
      body: JSON.stringify({
        name: "趋势确认规则",
        content: "首次信号只允许小仓位验证；结构再次确认后，才评估是否增加风险暴露。",
        changeSummary: "作品集 Demo 初始规则",
      }),
    });
    await page.goto(`${baseUrl}/decision/market-replay`, { waitUntil: "networkidle" });
    await caption(
      page,
      "InvestFlow Replay · 离线工程演示",
      "Synthetic 行情替换外部供给；Backend、订单事件、SQLite 账本与复盘仍走真实链路。",
      12000,
    );
    await caption(
      page,
      "01 · 研究假设进入可重复演练",
      "固定合成行情不对应真实证券，也不代表真实收益；同一输入可以稳定复现。",
      10000,
    );

    await page.getByRole("button", { name: "20 交易日", exact: true }).click();
    await page.getByRole("button", { name: "开始日线盲测", exact: true }).click();
    await page.getByRole("heading", { name: "历史行情盲测", exact: true }).waitFor();
    await caption(
      page,
      "02 · 匿名行情与真实会话",
      "创建场景后只展示 250 根观察日线；标的身份、未来日期与答案保持隐藏。",
      11000,
    );

    await page.getByRole("button", { name: "买入", exact: true }).click();
    const buyDialog = page.getByRole("dialog", { name: "买入决策记录", exact: true });
    await buyDialog.getByRole("button", { name: "比例", exact: true }).click();
    await buyDialog.getByRole("button", { name: "25%", exact: true }).click();
    await buyDialog.getByRole("checkbox", { name: "趋势", exact: true }).check({ force: true });
    await buyDialog.getByRole("checkbox", { name: "量价", exact: true }).check({ force: true });
    await buyDialog.getByRole("textbox", { name: /核心判断/u }).fill(
      "趋势结构保持完整，量价配合支持小仓位验证。",
    );
    await buyDialog.getByRole("textbox", { name: /开仓与持有计划/u }).fill(
      "先用四分之一仓位验证，下一交易日开盘执行。",
    );
    await buyDialog.getByRole("textbox", { name: /风险计划/u }).fill(
      "收盘跌破关键结构则判断失效，不追加风险仓位。",
    );
    await buyDialog.getByRole("spinbutton", { name: "止损价", exact: true }).fill("20");
    await caption(
      page,
      "03 · 下单前冻结决策证据",
      "仓位、理由、计划和风险边界随委托保存，成交后不能回写当时判断。",
      15000,
    );
    await buyDialog.getByRole("button", { name: "提交买入委托", exact: true }).click();

    const advance = page.getByRole("button", { name: /执行 1 笔委托并推进/u });
    await advance.waitFor();
    await caption(
      page,
      "04 · 下一开盘撮合",
      "待处理委托不会按当前收盘价成交；推进后按下一交易日开盘执行并记录费用。",
      10000,
    );
    await advance.click();
    await page.getByText("已推进 1 / 20 日", { exact: true }).waitFor();
    await caption(
      page,
      "成交事件已写入账本",
      "账户现金、持仓、T+1 锁定、累计费用和 revision 同步更新。",
      11000,
    );

    await page.getByRole("button", { name: "提前交卷", exact: true }).click();
    await page.getByRole("button", { name: "确认交卷", exact: true }).click();
    await page.getByRole("button", { name: "填写揭晓前盲评", exact: true }).waitFor();
    await caption(
      page,
      "05 · 状态机先完成，再允许揭晓",
      "交卷后不能继续交易；必须先冻结盲评，才能恢复标的身份和完整行情。",
      11000,
    );

    await page.getByRole("button", { name: "填写揭晓前盲评", exact: true }).click();
    const reviewDialog = page.getByRole("dialog", {
      name: "两阶段复盘 · 决策记录与评分",
      exact: true,
    });
    await reviewDialog.getByRole("combobox", {
      name: "参考战法（可选）",
      exact: true,
    }).selectOption({ label: "趋势确认规则 · 当前 v1" });
    await caption(
      page,
      "盲评关联不可变规则版本",
      "最近一次买入判断自动带入；保存时冻结所参考的 v1，而不是只保存可变名称。",
      13000,
    );
    await reviewDialog.getByRole("button", {
      name: "保存并冻结整局盲评",
      exact: true,
    }).click();
    await reviewDialog.getByText("原始盲评已锁定", { exact: true }).waitFor();
    await reviewDialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();

    await page.getByRole("button", { name: "揭晓答案", exact: true }).click();
    await page.getByText("答案已揭晓，可查看完整行情", { exact: true }).waitFor();
    await caption(
      page,
      "06 · 揭晓恢复真实上下文",
      "同一会话展示合成标的身份、真实日期和完整 270 根行情，原始盲评保持锁定。",
      12000,
    );

    await page.getByRole("button", { name: "查看复盘", exact: true }).click();
    await reviewDialog.getByRole("textbox", { name: /执行复盘/u }).fill(
      "执行与原计划一致，小仓位验证降低了判断错误的成本。",
    );
    await reviewDialog.getByRole("textbox", { name: /错误与不足/u }).fill(
      "观察窗口偏短，缺少第二次确认。",
    );
    await reviewDialog.getByRole("textbox", { name: /经验总结/u }).fill(
      "保留小仓位试错，并等待价格结构再次确认后再考虑加仓。",
    );
    await reviewDialog.getByRole("combobox", { name: "执行纪律", exact: true }).selectOption("4");
    await reviewDialog.getByRole("combobox", { name: "风险控制", exact: true }).selectOption("4");
    await reviewDialog.getByRole("combobox", { name: "战法复核", exact: true }).selectOption("4");
    await reviewDialog.getByRole("textbox", { name: /战法调整建议/u }).fill(
      "新增规则：首次信号只允许四分之一仓位，第二次结构确认后再评估加仓。",
    );
    await caption(
      page,
      "07 · 复盘建议不是自动改规则",
      "事后评分、错误与经验写入账本；调整建议先成为候选，保留人工决策点。",
      15000,
    );
    await reviewDialog.getByRole("button", {
      name: "保存原始复盘并评分",
      exact: true,
    }).click();
    await reviewDialog.getByText("原始事后复盘已锁定", { exact: true }).waitFor();
    await reviewDialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();

    await page.getByRole("link", { name: "交易追踪", exact: true }).click();
    await page.getByRole("button", { name: "历史演练", exact: true }).click();
    await page.getByRole("heading", { name: "历史演练", exact: true }).waitFor();
    await caption(
      page,
      "08 · 结果可追溯",
      "历史页同时保留逐笔成交、冻结盲评、事后复盘、评分算法和资金使用证据。",
      13000,
    );
    await page.getByRole("button", { name: "一键加入候选改进", exact: true }).click();
    await page.getByRole("button", { name: "战法库", exact: true }).click();
    await page.getByRole("button", { name: "趋势确认规则 当前 v1", exact: true }).click();
    await page.getByRole("heading", { name: "趋势确认规则", exact: true }).waitFor();
    await caption(
      page,
      "09 · 候选等待人工采纳",
      "复盘建议不会覆盖 v1；战法库明确显示待处理候选和不可变版本历史。",
      12000,
    );

    await page.locator('summary[aria-label="候选改进操作"]').click();
    await page.getByRole("button", { name: "采纳并生成版本", exact: true }).click();
    await caption(
      page,
      "人工确认完整新正文与变更说明",
      "采纳操作基于当前 v1 创建新版本，旧版本继续保留。",
      10000,
    );
    await page.getByRole("button", {
      name: "确认采纳并创建版本",
      exact: true,
    }).click();
    await page.getByText("当前生效版本 v2", { exact: true }).waitFor();
    await caption(
      page,
      "一次规则验证闭环完成",
      "研究假设 → 行情演练 → 模拟执行 → 复盘 → 人工确认后的规则 v2。",
      14000,
    );
    await clearCaption(page);
    await wait(Math.max(1, Math.round(3000 * timeScale)));
  } finally {
    await context.close();
    await browser.close();
  }

  const webmPath = await video.path();
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryOutput = join(tempDir, "InvestFlow-Replay-offline-demo.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-i", webmPath,
    "-vf", "tpad=stop_mode=clone:stop_duration=8",
    "-c:v", "libx264",
    "-crf", "23",
    "-preset", "medium",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    temporaryOutput,
  ], { stdio: "inherit" });
  renameSync(temporaryOutput, outputPath);
  rmSync(tempDir, { recursive: true, force: true });
  console.log(`Demo 视频已生成：${outputPath}`);
}

main().catch((error) => {
  rmSync(tempDir, { recursive: true, force: true });
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
