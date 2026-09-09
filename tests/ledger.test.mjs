/* Sprint 1 单测：账本（成本/盈亏/滚动/买卖矩阵）+ jsdom 端到端盈亏链路 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const FP = require("../js/core.js");
const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------- 纯函数：滚动 ---------- */
const NAV = [
  {d: "2026-09-01", nav: 1, pct: 1},
  {d: "2026-09-02", nav: 1, pct: 2},
  {d: "2026-09-03", nav: 1, pct: -1},
  {d: "2026-09-04", nav: 1, pct: 0.5},
];

test("rollFactor：快照日后每日涨跌累乘", () => {
  // 09-01 之后：2% * -1% * 0.5%
  assert.ok(Math.abs(FP.rollFactor(NAV, "2026-09-01") - 1.02 * 0.99 * 1.005) <= 1e-9);
});

test("rollFactor：已是最新日/无更新返回 null；起点早于数据只滚可见段", () => {
  assert.equal(FP.rollFactor(NAV, "2026-09-04"), null);
  assert.equal(FP.rollFactor(NAV, "2026-09-05"), null);
  assert.equal(FP.rollFactor([], "2026-09-01"), null);
  assert.equal(FP.rollFactor(null, "2026-09-01"), null);
  // 快照早于序列起点（40 天前录入）：滚全部可见段
  assert.ok(Math.abs(FP.rollFactor(NAV, "2026-08-01") - 1.01 * 1.02 * 0.99 * 1.005) <= 1e-9);
});

test("rolledAmt：滚动市值取 2 位", () => {
  assert.ok(Math.abs(FP.rolledAmt(100, NAV, "2026-09-01") - 100 * 1.02 * 0.99 * 1.005) <= 0.005);
  assert.equal(FP.rolledAmt(100, NAV, "2026-09-04"), 100);   // 无更新原值
});

/* ---------- 纯函数：买卖矩阵 ---------- */
test("applyBuy：成本与市值同增；null 成本自动开账", () => {
  assert.deepEqual(FP.applyBuy(1000, 1200, 500), {cost: 1500, amt: 1700});
  const r = FP.applyBuy(null, 1200, 500);
  assert.deepEqual(r, {cost: 500, amt: 1700});   // 买入即投入 → 开账
});

test("applySell：按比例摊减成本；超卖 clamp；null 成本保持 null", () => {
  // 卖一半：cost/amt 各减半
  assert.deepEqual(FP.applySell(1000, 2000, 1000), {cost: 500, amt: 1000});
  // 超卖：amt clamp 0、成本摊完
  assert.deepEqual(FP.applySell(1000, 2000, 5000), {cost: 0, amt: 0});
  // 未录成本：不能凭空造 0 成本（假盈利）
  assert.deepEqual(FP.applySell(null, 2000, 1000), {cost: null, amt: 1000});
});

test("pnlOf：盈亏与收益率；未录成本 → null", () => {
  assert.deepEqual(FP.pnlOf(1100, 1000), {pnl: 100, pct: 10});
  assert.deepEqual(FP.pnlOf(990, 1000), {pnl: -10, pct: -1});
  assert.deepEqual(FP.pnlOf(1100, null), {pnl: null, pct: null});
  assert.deepEqual(FP.pnlOf(1100, 0), {pnl: 1100, pct: 0});
});

test("openBook/round2：开账成本=市值；2 位舍入", () => {
  assert.equal(FP.openBook(1234.567), 1234.57);
  assert.equal(FP.round2(0.1 + 0.2), 0.3);
});

/* ---------- jsdom 端到端 ---------- */
const HTML = readFileSync(join(ROOT, "..", "index.html"), "utf8");
const CORE = readFileSync(join(ROOT, "..", "js", "core.js"), "utf8");
const marketData = JSON.parse(readFileSync(join(ROOT, "..", "data", "market.json"), "utf8"));
const fundsData = JSON.parse(readFileSync(join(ROOT, "..", "data", "funds.json"), "utf8"));

async function loadPage() {
  const dom = new JSDOM(HTML, {
    url: "http://localhost:8377/index.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.setInterval = () => 0;
      window.eval(CORE);   // jsdom 不走 window.fetch 加载子资源，core.js 从磁盘注入
      window.fetch = async url => {
        const u = String(url);
        if (u.includes("market.json")) return {ok: true, status: 200, json: async () => marketData};
        if (u.includes("funds.json")) return {ok: true, status: 200, json: async () => fundsData};
        throw new TypeError("network blocked in test: " + u);
      };
    },
  });
  const { window } = dom;
  await new Promise(r => window.addEventListener("load", r));
  await new Promise(r => setTimeout(r, 80));
  return { dom, window };
}

test("端到端：旧数据按 fundsCfg.added 自动滚动市值（迁移）", async () => {
  const { window } = await loadPage();
  // 模拟旧数据：020691 于 09-04 录入 3000，无 cost/d；market 最新净值日 09-03
  window.eval(`amounts = {"020691": {amt: 3000, name: "通信设备指数A"}}; lsSet(LS.amt, amounts);`);
  window.syncValues();
  const rec = window.eval(`amounts["020691"]`);
  const nav = marketData.funds["020691"].nav_history;
  const lastD = nav[nav.length - 1].d;
  assert.equal(rec.d, lastD, "快照日应推进到最新净值日");
  const f = FP.rollFactor(nav, "2026-09-04");
  if (f == null) assert.equal(rec.amt, 3000);   // 无更新段
  else assert.ok(Math.abs(rec.amt - 3000 * f) <= 0.01);
});

test("端到端：表单录入→开账；盈亏渲染；✎ 补录成本", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {}; txns = [];`);
  // 1) 添加基金：市值 100，成本留空 → 开账
  doc.getElementById("nCode").value = "020691";
  doc.getElementById("nName").value = "通信设备指数A";
  doc.getElementById("nAmt").value = "100";
  doc.getElementById("nCost").value = "";
  window.eval(`window.confirm = () => true;`);   // ghWriteFunds 无 token 直接 false，不阻断
  await window.eval(`document.getElementById("btnAddFund").click()`);   // await async handler
  await new Promise(r => setTimeout(r, 50));
  let rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.cost, FP.openBook(100), "留空成本按市值开账");
  assert.ok(rec.d, "快照日应落库");
  // 2) Hero 盈亏 = 0（开账口径）
  window.renderDash();
  assert.ok(doc.getElementById("heroPnl").textContent.includes("+0.00"), "开账盈亏应显示 +0.00");
  // 3) ✎ 补录成本 200 → 盈亏 = 100-200 = -100
  window.prompt = () => "200";
  window.setCost("020691");
  rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.cost, 200);
  window.renderDash();
  const heroPnl = doc.getElementById("heroPnl").textContent;
  assert.ok(heroPnl.includes("-100"), `Hero 应显示 -100：${heroPnl}`);
});

test("端到端：买入加成本、卖出摊减（交易联动账本）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"020691": {amt: 1000, cost: 1000, name: "通信设备指数A", d: ${JSON.stringify(window.eval("latestNavDate('020691')"))}}};`);
  window.navTo("entry");
  window.refreshFundSelect();
  doc.getElementById("tFund").value = "020691";
  doc.getElementById("tAction").value = "加仓";
  doc.getElementById("tAmt").value = "500.55";
  window.eval(`document.getElementById("btnAddTxn").click()`);
  let rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.cost, 1500.55, "加仓后成本 1000+500.55");
  assert.ok(Math.abs(rec.amt - 1500.55) <= 0.01, "加仓后市值");
  // 卖出 1/3：成本按比例摊减
  doc.getElementById("tAction").value = "减仓";
  doc.getElementById("tAmt").value = "500.18";
  window.eval(`document.getElementById("btnAddTxn").click()`);
  rec = window.eval(`amounts["020691"]`);
  assert.ok(Math.abs(rec.cost - 1500.55 * (1 - 500.18 / 1500.55)) <= 0.01, "卖出后成本按比例摊减");
  assert.ok(Math.abs(rec.amt - (1500.55 - 500.18)) <= 0.01, "卖出后市值");
  // 流水两条
  assert.equal(window.eval("txns.length"), 2);
});

test("端到端：识别弹窗带成本入库（持仓快照路径）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {}; txns = [];`);
  window.showConfirm("识别", [{code: "020640", name: "半导体ETF联接C", amount: 84.5, cost: 100, action: "持仓"}]);
  assert.ok(doc.getElementById("cf_o0"), "成本输入框存在");
  window.eval(`document.getElementById("modalOk").click()`);
  await new Promise(r => setTimeout(r, 30));   // modalOk 是 async handler（ghWriteFunds 微任务）
  const rec = window.eval(`amounts["020640"]`);
  assert.equal(rec.amt, 84.5, "市值=快照");
  assert.equal(rec.cost, 100, "成本=识别值");
  assert.ok(rec.d, "快照日落库");
  // 明细持有收益：-15.5 / -15.5%
  window.navTo("txn");
  window.renderTxnView();
  const rows = doc.getElementById("holdRows").textContent;
  assert.ok(rows.includes("-15.50"), `持有收益应显示 -15.50：${rows}`);
});

test("端到端：未录成本 → 持有收益列显示提示，不显示误导性 0", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"020691": {amt: 3000, name: "通信设备指数A", d: latestNavDate("020691")}};`);
  window.navTo("txn");
  window.renderTxnView();
  const rows = doc.getElementById("holdRows").textContent;
  assert.ok(rows.includes("未录成本"), "应提示未录成本");
  // Hero 显示补录提示
  window.renderDash();
  assert.ok(doc.getElementById("heroPnl").textContent.includes("补录"), "Hero 应提示补录成本");
});

test("回归：fmtY 保留两位小数（用户报障：录入小数被抹掉）", async () => {
  const { window } = await loadPage();
  assert.equal(window.eval(`fmtY(0.76)`), "¥0.76");
  assert.equal(window.eval(`fmtY(84.5)`), "¥84.50");
  assert.equal(window.eval(`fmtY(1234.5)`), "¥1,234.50");
  assert.equal(window.eval(`fmtY(123456.78)`), "¥12.35万");
});

test("回归：GitHub 仓库预填（双横线）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  assert.equal(doc.getElementById("sRepo").value, "511678/fund--portfolio");
});
