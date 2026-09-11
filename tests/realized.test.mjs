/* 已实现盈亏（卖出落袋）测试：纯函数 + jsdom 端到端 */
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

/* ---------- 纯函数 ---------- */
test("applySell：卖出落袋 = 卖出所得 − 卖出部分成本", () => {
  // 成本1000、市值1500，全卖：落袋 1500-1000 = +500
  assert.deepEqual(FP.applySell(1000, 1500, 1500),
    {cost: 0, amt: 0, realizedDelta: 500});
  // 部分卖一半：落袋 750-500 = +250
  assert.deepEqual(FP.applySell(1000, 1500, 750),
    {cost: 500, amt: 750, realizedDelta: 250});
  // 亏损卖：成本1000、市值800 全卖：落袋 -200
  assert.deepEqual(FP.applySell(1000, 800, 800),
    {cost: 0, amt: 0, realizedDelta: -200});
  // 未录成本：无法计算落袋 → null
  assert.deepEqual(FP.applySell(null, 1500, 1500),
    {cost: null, amt: 0, realizedDelta: null});
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
      window.eval(CORE);
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

test("端到端：卖出自动落袋，清仓后已落袋保留且计入总账", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 成本1000 市值1500（用户快照）
  window.eval(`amounts = {"020691": {amt: 1500, cost: 1000, name: "通信设备指数A", d: latestNavDate("020691")}}; txns = [];`);
  window.navTo("entry");
  window.refreshFundSelect();
  doc.getElementById("tFund").value = "020691";
  doc.getElementById("tAction").value = "卖出";
  doc.getElementById("tAmt").value = "1500";
  window.eval(`document.getElementById("btnAddTxn").click()`);
  const rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.amt, 0, "清仓后市值 0");
  assert.equal(rec.cost, 0, "成本摊完");
  assert.equal(rec.realized, 500, "落袋 +500 自动记录");
  // 清仓基金保留在「我的基金」表，已落袋列显示 +500.00
  window.navTo("txn");
  window.renderTxnView();
  const table = doc.getElementById("myFundsTable").textContent;
  assert.ok(table.includes("通信设备指数A"), "清仓基金仍在我的基金表");
  assert.ok(table.includes("+500.00"), "已落袋列显示 +500.00");
  // Hero 总账：累计盈亏 = 持有 0 + 已落袋 500
  window.renderDash();
  const hero = doc.getElementById("heroPnl").textContent;
  assert.ok(hero.includes("+500.00"), `Hero 总盈亏 +500：${hero}`);
  assert.ok(hero.includes("已落袋"), `Hero 拆分含已落袋：${hero}`);
});

test("端到端：分批卖出累计落袋 + 持有盈亏并存", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 成本1000 市值1500，先卖一半（+250），再卖一半（+250）
  window.eval(`amounts = {"020691": {amt: 1500, cost: 1000, name: "通信设备指数A", d: latestNavDate("020691")}}; txns = [];`);
  window.navTo("entry");
  window.refreshFundSelect();
  doc.getElementById("tFund").value = "020691";
  doc.getElementById("tAction").value = "减仓";
  doc.getElementById("tAmt").value = "750";
  window.eval(`document.getElementById("btnAddTxn").click()`);
  doc.getElementById("tAmt").value = "750";
  window.eval(`document.getElementById("btnAddTxn").click()`);
  let rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.realized, 500, "两批合计落袋 +500");
  // 重新持仓观察并存展示：市值 800 成本 600（持有+200）+ 落袋 500
  window.eval(`amounts["020691"].amt = 800; amounts["020691"].cost = 600;`);
  window.renderDash();
  const hero = doc.getElementById("heroPnl").textContent;
  assert.ok(hero.includes("+700.00"), `总账 = 200+500 = +700：${hero}`);
  assert.ok(hero.includes("持有"), hero.includes("已落袋") ? "拆分齐" : "缺持有");
  // 持仓行 sub 附带落袋
  window.navTo("txn");
  window.renderTxnView();
  const rows = doc.getElementById("holdRows").textContent;
  assert.ok(rows.includes("落袋+500.00"), `持仓行应显示落袋：${rows}`);
});

test("端到端：✎ 已落袋手动补录（用户把 App 里的历史已实现收益录进来）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"020691": {amt: 3000, cost: 2800, name: "通信设备指数A", d: latestNavDate("020691")}};`);
  window.prompt = () => "39.03";   // 天天基金 App 显示的已实现收益
  window.setRealized("020691");
  let rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.realized, 39.03);
  // Hero：持有 +200 + 落袋 +39.03 = +239.03
  window.renderDash();
  const hero = doc.getElementById("heroPnl").textContent;
  assert.ok(hero.includes("+239.03"), `总账 200+39.03：${hero}`);
  // 留空 = 清零
  window.prompt = () => "";
  window.setRealized("020691");
  rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.realized, undefined, "留空清零");
  // 负数（卖出亏损）允许
  window.prompt = () => "-12.5";
  window.setRealized("020691");
  assert.equal(window.eval(`amounts["020691"].realized`), -12.5);
});

test("端到端：未录成本的基金卖出 → 不产生假落袋", async () => {
  const { window } = await loadPage();
  window.eval(`amounts = {"020691": {amt: 1500, name: "通信设备指数A", d: latestNavDate("020691")}}; txns = [];`);
  window.navTo("entry");
  window.refreshFundSelect();
  window.document.getElementById("tFund").value = "020691";
  window.document.getElementById("tAction").value = "卖出";
  window.document.getElementById("tAmt").value = "1500";
  window.eval(`document.getElementById("btnAddTxn").click()`);
  const rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.amt, 0);
  assert.equal(rec.realized, undefined, "未录成本不产生假落袋");
});

test("端到端：识别弹窗卖出分支同样累计落袋", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"020691": {amt: 1500, cost: 1000, name: "通信设备指数A", d: latestNavDate("020691")}}; txns = [];`);
  window.showConfirm("识别", [{code: "020691", name: "通信设备指数A", amount: 750, action: "卖出"}]);
  window.eval(`document.getElementById("modalOk").click()`);
  await new Promise(r => setTimeout(r, 30));
  const rec = window.eval(`amounts["020691"]`);
  assert.equal(rec.realized, 250, "识别卖出半仓 → 落袋 +250");
});

test("回归：新录基金无 market 数据时总览不崩（用户报障：总览空白卡死）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 020691 在 market.json；999888 是新录的、Action 还没抓到数据 → 触发 compute 裸访问崩溃
  window.eval(`amounts = {
    "020691": {amt: 3000, cost: 2800, name: "通信设备指数A", d: latestNavDate("020691")},
    "999888": {amt: 500, cost: 500, name: "新基金还没有数据", d: "2026-09-07"}
  };`);
  window.renderDash();   // 修复前这里抛 nav_history undefined
  assert.ok(!doc.getElementById("updBadge").textContent.includes("⚠️"),
    "不得有未捕获错误: " + doc.getElementById("updBadge").textContent);
  assert.equal(doc.getElementById("heroAmt").textContent, "¥3,500.00", "总市值含无数据基金");
  const heroPnl = doc.getElementById("heroPnl").textContent;
  assert.ok(heroPnl.includes("+200.00"), `持有盈亏应显示 +200：${heroPnl}`);
});

/* ---------- 板块手选（东财板块列表） ---------- */
test("板块手选：覆盖自动归类（手选 ＞ 行业数据 ＞ 兜底）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 020691 有真实行业数据（信息技术）；手选"白酒"后整个基金应归消费
  window.eval(`amounts = {"020691": {amt: 3000, cost: 2800, name: "通信设备指数A",
    sector: "白酒", d: latestNavDate("020691")}};`);
  window.renderDash();
  const legend = doc.getElementById("legendTable").textContent;
  assert.ok(legend.includes("消费"), `手选白酒应归消费板块：${legend}`);
  assert.ok(!legend.includes("信息技术"), "手选后不应再按行业归信息技术");
  // 明细行板块列显示手选值 + 手选标记
  window.navTo("txn");
  window.renderTxnView();
  const rows = doc.getElementById("holdRows").textContent;
  assert.ok(rows.includes("白酒 · 手选"), `明细板块应显示手选：${rows}`);
  // 我的基金表板块按钮显示手选板块
  const table = doc.getElementById("myFundsTable").textContent;
  assert.ok(table.includes("白酒 ✎"), `我的基金表应显示手选：${table}`);
});

test("板块手选：清除手选恢复自动归类", async () => {
  const { window } = await loadPage();
  window.eval(`amounts = {"020691": {amt: 3000, cost: 2800, name: "通信设备指数A",
    sector: "白酒", d: latestNavDate("020691")}};`);
  window.eval(`openSectorPicker({code: "020691"});`);
  window.eval(`document.getElementById("secClear").click()`);
  assert.equal(window.eval(`amounts["020691"].sector`), undefined, "清除后 sector 应删除");
  window.renderDash();
  const legend = window.document.getElementById("legendTable").textContent;
  assert.ok(legend.includes("信息技术"), "恢复后按真实行业归信息技术");
});

test("板块选择器：搜索过滤与点选落库", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"020691": {amt: 3000, cost: 2800, name: "通信设备指数A", d: latestNavDate("020691")}};`);
  // 用注入的假板块列表（不依赖网络）
  window.eval(`sectorCache = {at: Date.now(), list: [
    {name: "半导体", code: "BK1036", pct: 2.5},
    {name: "白酒", code: "BK0477", pct: -1.2},
    {name: "通信设备", code: "BK1015", pct: 0.8}]};`);
  window.eval(`openSectorPicker({code: "020691"})`);
  assert.ok(doc.getElementById("secModalBg").classList.contains("on"), "模态应打开");
  // 搜索过滤
  const inp = doc.getElementById("secSearch");
  inp.value = "白酒";
  window.eval(`renderSectorList("白酒")`);
  const items = doc.querySelectorAll(".sec-item");
  assert.equal(items.length, 1, "搜索'白酒'应只剩 1 项");
  // 点选
  window.eval(`document.querySelector(".sec-item").click()`);
  assert.equal(window.eval(`amounts["020691"].sector`), "白酒", "点选后 sector 落库");
  assert.ok(!doc.getElementById("secModalBg").classList.contains("on"), "选后模态关闭");
});
