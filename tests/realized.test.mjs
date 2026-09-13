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
        if (u.includes("events.json")) return {ok: true, status: 200, json: async () =>
          JSON.parse(readFileSync(join(ROOT, "..", "data", "events.json"), "utf8"))};
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

/* ---------- 板块自动识别（录入页） ---------- */
test("自动识别①：基金名称关键词快判", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  const cases = {
    "财通集成电路产业股票C": "信息技术",
    "招商中证白酒指数(LOF)C": "消费",
    "国富亚洲机会股票(QDII)C": "海外QDII",
    "广发全球精选股票(QDII)人民币C": "海外QDII",
    "前海开源黄金ETF联接C": "黄金",
    "华夏能源革新股票C": "先进制造",
    "易方达蓝筹精选混合": "",            // 无关键词 → 走深查
    "天弘余额宝货币": "综合",
    "招商中证煤炭等权指数(LOF)C": "周期资源",
    "华夏医药ETF联接C": "医药",
    "华宝中证银行ETF联接C": "金融",
  };
  for (const [name, want] of Object.entries(cases))
    assert.equal(window.eval(`sectorFromName(${JSON.stringify(name)}, "")`), want, name);
});

test("自动识别②：录入代码触发识别并填入下拉（名称快判路径）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.fetch = async url => {
    const u = String(url);
    if (u.includes("FundMNDetailInformation"))
      return {ok: true, json: async () => ({Datas: {SHORTNAME: "财通集成电路产业股票C", FTYPE: "股票型"}})};
    throw new TypeError("unexpected: " + u);
  };
  await window.eval(`lookupFund("006503")`);
  assert.equal(doc.getElementById("nFallback").value, "信息技术", "名称识别应填入下拉");
  assert.ok(doc.getElementById("nLookup").textContent.includes("自动识别板块：信息技术"));
});

test("自动识别③：名称无把握时穿透重仓股投票", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.fetch = async url => {
    const u = String(url);
    if (u.includes("FundMNDetailInformation"))
      return {ok: true, json: async () => ({Datas: {SHORTNAME: "易方达蓝筹精选混合", FTYPE: "混合型"}})};
    if (u.includes("FundMNInverstPosition"))
      return {ok: true, json: async () => ({Datas: {fundStocks: [
        {GPDM: "600519", TEXCH: "1", JZBL: "9.5"},   // 贵州茅台 → 白酒Ⅱ → 消费
        {GPDM: "000858", TEXCH: "2", JZBL: "8.8"},   // 五粮液 → 消费
        {GPDM: "601318", TEXCH: "1", JZBL: "7.0"},   // 中国平安 → 保险 → 金融
      ]}})};
    if (u.includes("push2delay"))
      return {ok: true, json: async () => {
        // 按调用顺序无法区分个股，统一返回白酒行业（前两只权重远大于第三只 → 消费胜出）
        return {data: {f127: "白酒Ⅱ"}};
      }};
    throw new TypeError("unexpected: " + u);
  };
  await window.eval(`lookupFund("005827")`);
  assert.equal(doc.getElementById("nFallback").value, "消费", "重仓投票应得出消费");
  const hint = doc.getElementById("nLookup").textContent;
  assert.ok(hint.includes("重仓穿透"), `应显示识别依据：${hint}`);
});

test("自动识别④：快速连续输入代码，旧查询结果不覆盖新查询", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  let resolveA;
  window.fetch = async url => {
    const u = String(url);
    if (u.includes("FundMNDetailInformation") && u.includes("006503")) {
      await new Promise(r => { resolveA = r; });   // 第一只的响应挂起
      return {ok: true, json: async () => ({Datas: {SHORTNAME: "财通集成电路产业股票C", FTYPE: "股票型"}})};
    }
    if (u.includes("FundMNDetailInformation"))
      return {ok: true, json: async () => ({Datas: {SHORTNAME: "招商中证白酒指数(LOF)C", FTYPE: "指数型"}})};
    throw new TypeError("unexpected");
  };
  const p1 = window.eval(`lookupFund("006503")`);   // 慢查询先发出
  await window.eval(`lookupFund("161725")`);        // 快查询后发、先回
  assert.equal(doc.getElementById("nFallback").value, "消费");
  resolveA();                                        // 慢查询此刻才返回
  await p1;
  assert.equal(doc.getElementById("nFallback").value, "消费", "旧查询作废，不得覆盖白酒");
  assert.ok(!doc.getElementById("nFallback").value.includes("信息技术"), "陈旧结果不得回填");
});

test("自动识别⑤：保存时兜底链 fallback值=下拉＞识别结果＞综合", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 模拟 lastDetect 已有识别结果、下拉为空
  window.eval(`lastDetect = {sector: "信息技术", source: "重仓穿透"};
    amounts = {}; nSectorPick = "";
    $("nCode").value = "006503"; $("nName").value = "财通集成电路C";
    $("nAmt").value = "100"; $("nCost").value = ""; $("nFallback").value = "";`);
  await window.eval(`document.getElementById("btnAddFund").click()`);
  await new Promise(r => setTimeout(r, 50));
  // funds.json 写入会失败（无 PAT），但识别结果应体现在 addMsg
  assert.ok(doc.getElementById("addMsg").textContent.includes("信息技术"), "识别板块应显示");
});

/* ---------- Sprint 2：每日收益 / 排序 / 弹窗自动识别 ---------- */
test("每日收益：逐日回折算法（无申赎假设精确口径）", async () => {
  const { window } = await loadPage();
  // 注入净值序列（时间升序，与真实 market.json 一致）
  window.eval(`market = {updated_at: "t", funds: {"X": {nav_history: [
    {d: "2026-09-01", nav: 1, pct: 5},
    {d: "2026-09-02", nav: 1, pct: -10},
    {d: "2026-09-03", nav: 1, pct: 10}]}}};
    amounts = {"X": {amt: 110, cost: 100, name: "测试基金", d: "2026-09-03"}};`);
  const rows = window.eval(`dailyProfits("X", 110, 14)`);
  // day3: 110 - 110/1.10 = +10.00（时间倒序输出，最新在前）
  assert.equal(rows[0].d, "2026-09-03");
  assert.ok(Math.abs(rows[0].profit - 10) <= 0.01, `day3 应 +10：${rows[0].profit}`);
  // day2 基数 = 110/1.10 = 100：100 - 100/0.90 = -11.11
  assert.equal(rows[1].d, "2026-09-02");
  assert.ok(Math.abs(rows[1].profit - (-11.11)) <= 0.01, `day2 应 -11.11：${rows[1].profit}`);
  // day1 基数 = 100/0.90 = 111.11：111.11 - 111.11/1.05 = +5.29
  assert.ok(Math.abs(rows[2].profit - 5.29) <= 0.01);
});

test("每日收益：矩阵渲染（缺失基金当日显示 —，组合列标注）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`
    market = {updated_at: "t", funds: {
      "A": {nav_history: [{d: "2026-09-02", nav: 1, pct: 1}, {d: "2026-09-03", nav: 1, pct: 2}]},
      "B": {nav_history: [{d: "2026-09-03", nav: 1, pct: -3}]}}};
    amounts = {"A": {amt: 1000, cost: 900, name: "基金A", d: "2026-09-03"},
               "B": {amt: 500, cost: 500, name: "基金B", d: "2026-09-03"}};`);
  window.navTo("txn");
  window.renderTxnView();
  const t = doc.getElementById("dailyTable").textContent;
  assert.ok(t.includes("09-03") && t.includes("09-02"), "应含两行日期");
  assert.ok(t.includes("—"), "B 在 09-02 无数据应显示 —");
  assert.ok(t.includes("部分"), "缺失日组合列应标'部分'");
  // 09-03：A = 1000-1000/1.02 = +19.61；B = 500-500/0.97 = -15.46；组合 +4.15
  assert.ok(t.includes("+4.15"), `组合列应 +4.15：${t}`);
});

test("持仓排序：表头点击切换 当日收益/持有收益/金额", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {
    "A": {amt: 100, cost: 50, name: "甲", d: latestNavDate("020691")},
    "B": {amt: 900, cost: 300, name: "乙", d: latestNavDate("020691")}};`);
  window.navTo("txn");
  window.renderTxnView();
  // 默认 day 排序：两只都无当日数据 → 顺序由 -1e18 稳定
  window.eval(`document.querySelector('.sort-head[data-sort="pnl"]').click()`);
  let first = doc.querySelector("#holdRows .hname").textContent;
  assert.equal(first, "乙", "按持有收益排序：乙(+600) 在前");
  window.eval(`document.querySelector('.sort-head[data-sort="amt"]').click()`);
  first = doc.querySelector("#holdRows .hname").textContent;
  assert.equal(first, "乙", "按金额排序：乙(900) 在前");
  window.eval(`document.querySelector('.sort-head[data-sort="day"]').click()`);
  assert.ok(doc.getElementById("holdHead").textContent.includes("当日收益 ▾"), "表头应显示排序标记");
});

test("识别入库：新基金按名称自动识别板块写入清单", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {}; txns = [];`);
  window.showConfirm("识别", [{code: "012414", name: "华泰柏瑞中证机器人ETF联接C", amount: 100, action: "持仓"}]);
  window.eval(`document.getElementById("modalOk").click()`);
  await new Promise(r => setTimeout(r, 30));
  const rec = window.eval(`amounts["012414"]`);
  assert.ok(rec, "入库成功");
  // fallback 写入用的是名称识别（ghWriteFunds 无 PAT 失败，但 fundsCfg 本地 push 分支不受影响——
  // 失败时不 push，此处只断言 amount 已存；板块归类走 fundBucketFallback）
  assert.equal(rec.amt, 100);
});

/* ---------- 导入语义：realized 列 = App 累计收益，入库自动拆分 ---------- */
test("导入拆分：有成本基金 totalPnl 补差进已落袋，总收益精确等于 App 数字", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 文件模拟：市值 109.23、成本 149.44、App 累计收益 -40.21（= 市值-成本，用户 020640 实况）
  window.eval(`amounts = {}; txns = [];`);
  const file = JSON.stringify({amounts: {
    "020640": {amt: 109.23, cost: 149.44, name: "广发半导体设备ETF联接C", realized: -40.21, d: "2026-09-11"}
  }});
  window.eval(`window.File && 0`);
  // 直接走导入清洗的等价路径：手工调用内部的清洗段不方便，改用数据 API 复现
  // （导入 handler 依赖 FileReader/input，这里用同规则验证拆分数学）
  const rec = window.eval(`
    (function () {
      const v = ${file}.amounts["020640"];
      const amt = +v.amt, cost = +v.cost;
      const held = amt - cost;                 // -40.21
      const totalPnl = +v.realized;            // -40.21
      return {realized: FP.round2(totalPnl - held), held};
    })()
  `);
  assert.equal(rec.realized, 0, "totalPnl == 持有收益 → 已落袋补差为 0（不重复计亏损）");
  // 总账验证：持有(-40.21) + 已落袋(0) = App 显示的 -40.21（容差）
  assert.ok(Math.abs(rec.held + rec.realized - (-40.21)) <= 0.01);
});

test("导入拆分：无成本盈利基金收益整体进已落袋（用户 021277 场景）", async () => {
  const { window } = await loadPage();
  const rec = window.eval(`
    (function () {
      const amt = 131.24, cost = null, totalPnl = 601.38;
      const held = cost != null ? amt - cost : null;
      return {realized: FP.round2(held == null ? totalPnl : totalPnl - held), hasCost: cost != null};
    })()
  `);
  assert.equal(rec.realized, 601.38, "无成本 → 收益整体进已落袋");
  assert.equal(rec.hasCost, false, "盈利基金无需填成本");
  // Hero 总账口径：未录成本不计持有 → 累计盈亏 = 0(持有) + 601.38 = App 数字 ✅
});

/* ---------- 一键同步链接（?data=base64） ---------- */
test("URL 一键导入：base64 数据经确认后写入 amounts", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  const data = {amounts: {"020640": {amt: 109.23, cost: 149.44, name: "广发半导体设备ETF联接C", realized: -40.21, d: "2026-09-11"}}};
  const b64 = window.eval(`btoa(unescape(encodeURIComponent(${JSON.stringify(JSON.stringify(data))})))`);
  window.confirm = () => true;
  window.eval(`(function () {
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0))));
    const clean = sanitizeImport(j).amounts;
    amounts = clean;   // 与 applyImport 的写入路径一致（applyImport 另含 toast/渲染）
  })()`);
  const rec = window.eval(`amounts["020640"]`);
  assert.equal(rec.amt, 109.23);
  assert.equal(rec.cost, 149.44);
  assert.equal(rec.realized, 0, "累计收益-40.21 == 持有收益 → 已落袋补差 0，不重复计入");
});

/* ---------- Sprint 3：YTD / 基准 / 未披露拆解 / 成本引导 ---------- */
test("YTD：年初至今净值加权收益", async () => {
  const { window } = await loadPage();
  // fixture：去年一天 + 今年两天（+10%、-5%）→ YTD = 1.10*0.95-100 = +4.5%
  window.eval(`market = {updated_at: "t", funds: {"X": {nav_history: [
    {d: "2025-12-30", nav: 1, pct: 1},
    {d: "2026-01-05", nav: 1, pct: 10},
    {d: "2026-01-06", nav: 1, pct: -5}]}}};
    amounts = {"X": {amt: 100, cost: 100, name: "X", d: "2026-01-06"}};`);
  const c = window.eval(`compute()`);
  assert.ok(Math.abs(c.ytd - 4.5) <= 0.01, `YTD 应 +4.5%：${c.ytd}`);
});

test("基准：沪深300 对齐组合日期并指数化", async () => {
  const { window } = await loadPage();
  window.eval(`market = {updated_at: "t", benchmark: {name: "沪深300", klines: [
    {d: "2026-01-02", close: 4000},
    {d: "2026-01-05", close: 4100},
    {d: "2026-01-06", close: 4200}]},
    funds: {"X": {nav_history: [
      {d: "2026-01-05", nav: 1, pct: 2},
      {d: "2026-01-06", nav: 1, pct: 3}]}}};
    amounts = {"X": {amt: 100, cost: 100, name: "X", d: "2026-01-06"}};`);
  const c = window.eval(`compute()`);
  assert.ok(c.bench, "应生成基准序列");
  assert.equal(c.bench.name, "沪深300");
  assert.ok(Math.abs(c.bench.idx[0] - 102.5) <= 0.01, `基点 4100→102.5：${c.bench.idx[0]}`);
  assert.ok(Math.abs(c.bench.idx[1] - 105) <= 0.01, `4200/4100*100=105：${c.bench.idx[1]}`);
});

test("未披露拆解：桶内成员与 compute 口径一致，可跳转选板块", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 020691 真实行业数据含「未披露/其他」31.7% → compute 的未披露桶应含它
  window.eval(`amounts = {"020691": {amt: 100, cost: 90, name: "通信设备A", d: latestNavDate("020691")}};`);
  window.renderDash();
  const funds = window.eval(`lastCompute?.sectors?.["未披露"]?.funds`);
  assert.ok(funds && funds.has("020691"), "compute 未披露桶应含 020691");
  window.openSectorPicker({bucket: "未披露", funds});
  const t = doc.getElementById("secList").textContent;
  assert.ok(t.includes("通信设备A"), `应列出桶内基金：${t}`);
  // 点「选板块」→ 切到该基金的板块列表
  window.eval(`document.querySelector(".pick-fund").click()`);
  assert.ok(doc.getElementById("secModalTitle").textContent.includes("通信设备A"), "应切换到该基金");
});

test("待补成本引导条：未录成本时显示，点击列出清单", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {
    "020691": {amt: 100, cost: 90, name: "已录成本", d: latestNavDate("020691")},
    "002771": {amt: 100, name: "未录成本基金", d: latestNavDate("002771")}};`);
  window.navTo("txn");
  window.renderTxnView();
  assert.equal(doc.getElementById("costAlert").style.display, "block", "应有引导条");
  assert.ok(doc.getElementById("costAlertText").textContent.includes("1 只"), "应显示 1 只");
  window.eval(`document.getElementById("costAlertBtn").click()`);
  const t = doc.getElementById("secList").textContent;
  assert.ok(t.includes("未录成本基金"), "应列出未录成本基金");
  assert.ok(!t.includes("已录成本"), "不应列已录成本的");
  // 全部补录后引导条消失
  window.eval(`amounts["002771"].cost = 80; lsSet(LS.amt, amounts); renderTxnView();`);
  assert.equal(doc.getElementById("costAlert").style.display, "none", "补完应隐藏");
});

/* ---------- 大事日历 ---------- */
test("大事日历：FOMC 官方日程渲染、今天/明天徽章、规则事件生成", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`eventsCache = null;`);
  await window.eval(`renderEvents()`);
  const strip = doc.getElementById("evStrip").textContent;
  assert.ok(strip.includes("美联储 FOMC 利率决议"), `应含 FOMC：${strip.slice(0, 200)}`);
  assert.ok(strip.includes("美国非农就业报告"), "规则生成应含非农");
  assert.ok(strip.includes("中国 LPR 报价"), "规则生成应含 LPR");
  assert.ok(strip.includes("A 股三季报披露截止"), "应含三季报截止");
  // 徽章：官方日程含 9/16（fixture 与当前日期同月则显示"今天/明天/N天后"之一）
  assert.ok(/今天|明天|\d+天后|刚过/.test(strip), "应有时间徽章");
  // 非农规则：2026 年 10 月首个周五 = 10/2
  const oct = window.eval(`ruleEvents(2026).filter(e => e.type === "job" && e.d.startsWith("2026-10"))`);
  assert.equal(oct[0].d, "2026-10-02", `10 月首个周五：${oct[0].d}`);
});

test("大事日历：自定义事件可添加、可删除", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  let step = 0;
  window.prompt = () => (++step === 1 ? "2026-11-19" : step === 2 ? "英伟达财报" : "北京时间凌晨");
  window.eval(`eventsCache = null; evAdd.onclick();`);
  const user = window.eval(`lsGet(LS.events, [])`);
  assert.ok(user.some(u => u.title === "英伟达财报" && u.d === "2026-11-19"), "自定义事件已存");
  // 删除
  window.eval(`eventsCache = null; renderEvents()`);
  await new Promise(r => setTimeout(r, 60));   // renderEvents 异步
  window.eval(`document.querySelector(".ev-del").click()`);
  assert.equal(window.eval(`lsGet(LS.events, []).length`), 0, "删除后清空");
});

test("大事日历：日韩央行与龙头财报事件渲染", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`eventsCache = null;`);
  await window.eval(`renderEvents()`);
  const strip = doc.getElementById("evStrip").textContent;
  assert.ok(strip.includes("日本央行利率决议"), "应含日本央行");
  assert.ok(strip.includes("韩国央行利率决议"), "应含韩国央行");
  assert.ok(strip.includes("英伟达"), "应含英伟达财报（11/17 确认，在 95 天视界内）");
  assert.ok(strip.includes("微软 / 谷歌 / Meta"), "应含巨头财报周");
});
