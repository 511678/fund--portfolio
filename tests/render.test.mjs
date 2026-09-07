/* QA DOM 级验收：真实 index.html 在 jsdom 中执行，验证
   1) XSS 转义——恶意基金名/交易名渲染为文本，img/svg 不注入、onerror 不执行
   2) 未披露单列灰桶、失实标签修正、口径标注
   3) 视图切换与删除按钮（事件委托）可用
   运行：npm test（node --test tests/*.test.mjs） */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const market = JSON.parse(readFileSync(join(ROOT, "data", "market.json"), "utf8"));
const funds = JSON.parse(readFileSync(join(ROOT, "data", "funds.json"), "utf8"));

const XSS_NAME = '<img src=x onerror="document.title=\'XSS-FIRED\'">';
const XSS_NAME2 = "<svg/onload=alert(1)>";

async function loadPage() {
  const dom = new JSDOM(HTML, {
    url: "http://localhost:8377/index.html",
    runScripts: "dangerously",
    resources: "usable",          // 让 <img> 的 onerror 真正可触发（红绿验证关键）
    pretendToBeVisual: true,
    beforeParse(window) {
      window.setInterval = () => 0;   // 页面 60s 轮询会让测试进程挂起，屏蔽
    },
  });
  const { window } = dom;
  // mock 网络：market/funds 用真实仓库数据，外部接口一律拒绝
  window.fetch = async url => {
    const u = String(url);
    if (u.includes("market.json")) return { ok: true, status: 200, json: async () => market };
    if (u.includes("funds.json")) return { ok: true, status: 200, json: async () => funds };
    throw new TypeError("network blocked in test: " + u);
  };
  // 等主脚本 + loadData 渲染完成
  await new Promise(r => window.addEventListener("load", r));
  await new Promise(r => setTimeout(r, 80));
  return { dom, window };
}

test("页面加载：脚本执行、数据渲染、无 XSS 触发", async () => {
  const { window } = await loadPage();
  assert.equal(window.document.title, "基金板块分析");
  assert.equal(window.FP.bucketOf("半导体"), "信息技术");   // core.js 已加载
});

test("XSS：恶意基金名在持仓/明细/图例渲染为文本，不产生元素注入", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  // 通过全局词法环境写入恶意数据（模拟截图识别/语音/导入等不可信输入入库）
  window.eval(`
    amounts = {
      "002771": {amt: 5000, name: "安信新回报混合C"},
      "999999": {amt: 500, name: ${JSON.stringify(XSS_NAME)}}
    };
    txns = [{d: "2026-09-05", code: "999999", name: ${JSON.stringify(XSS_NAME2)},
             action: "买入", amount: 500}];
    lsSet(LS.amt, amounts); lsSet(LS.txn, txns);
  `);
  window.navTo("txn");
  window.renderTxnView();
  await new Promise(r => setTimeout(r, 120));   // 给 img onerror 触发留窗口

  assert.equal(doc.title, "基金板块分析", "document.title 不得被 onerror 改写");
  const hold = doc.getElementById("holdRows");
  assert.ok(hold.textContent.includes("onerror"), "payload 应以文本形式可见（转义而非吞掉）");
  assert.equal(hold.querySelectorAll("img").length, 0, "持仓区不得出现真实 <img>");
  const txn = doc.getElementById("txnTable");
  assert.ok(txn.textContent.includes("onload"));
  assert.equal(txn.querySelectorAll("svg").length, 0, "交易表不得出现真实 <svg>");
  // 确认弹窗（LLM 输出直进 value 属性的路径）
  window.showConfirm("图片识别结果", [{code: "999999", name: XSS_NAME, amount: 1, action: "持仓"}]);
  const inp = doc.getElementById("cf_n0");
  assert.equal(inp.value, XSS_NAME, "input.value 应还原原文（&quot; 解码回引号）");
  // 逃逸检测：若引号未被转义，属性在 onerror= 处提前终止，行结构会被破坏且 onerror 触发
  assert.equal(doc.querySelectorAll("#modalBody tr").length, 2, "表头+1 数据行（结构未被 payload 破坏）");
  assert.equal(doc.querySelectorAll("#modalBody input, #modalBody select").length, 4, "行内应恰好 4 个控件");
  assert.equal(doc.title, "基金板块分析", "value 属性注入不得改写 document.title");
  // "我的基金"表（原内联 onclick 注入点）——按钮应为 data-code 委托式
  const delBtn = doc.querySelector(".del-fund");
  assert.ok(delBtn, "删除按钮存在");
  assert.ok(!delBtn.getAttribute("onclick"), "不得使用内联 onclick");
  assert.equal(delBtn.dataset.code, "999999");
});

test("板块渲染：未披露单列灰桶，不混入综合；预警不含未披露", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"020691": {amt: 10000, name: "博时中证全指通信设备指数A"}}; lsSet(LS.amt, amounts);`);
  window.renderDash();
  const legend = doc.getElementById("legendTable").textContent;
  assert.ok(legend.includes("未披露"), "图例应单列未披露");
  const zongheCount = (legend.match(/综合/g) || []).length;
  assert.equal(zongheCount, 0, "020691 的未披露部分不应再进综合桶");
  const alertBar = doc.getElementById("alertBar");
  assert.ok(alertBar.style.display === "block", "信息技术占比>25% 应触发预警");
  assert.ok(!alertBar.textContent.includes("未披露"), "预警不得对未披露桶报警");
});

test("口径标注：总投入成本→持仓总市值；走势标题含回溯口径", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  const heroLabel = [...doc.querySelectorAll(".hero-label")].map(e => e.textContent).join();
  assert.ok(heroLabel.includes("持仓总市值"), heroLabel);
  assert.ok(!heroLabel.includes("总投入成本"));
  const trendH3 = [...doc.querySelectorAll("h3")].map(e => e.textContent).find(t => t.includes("组合净值走势"));
  assert.ok(trendH3.includes("当前持仓权重"), trendH3);
});

test("交互：视图切换与删除按钮（事件委托）可用", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.eval(`amounts = {"002771": {amt: 5000, name: "安信新回报混合C"}}; lsSet(LS.amt, amounts);`);
  window.navTo("txn");
  window.renderTxnView();
  assert.ok(doc.getElementById("view-txn").classList.contains("on"), "明细视图应打开");
  // 确认弹窗会阻塞 confirm()，stub 掉
  window.confirm = () => true;
  const btn = doc.querySelector(".del-fund");
  btn.click();          // 走 document 委托处理器
  await new Promise(r => setTimeout(r, 30));
  assert.equal(window.eval("Object.keys(amounts).length"), 0, "点击删除后基金应被移除");
});

test("本地日期：录入日期控件取本地时区（北京时间 0~8 点不差天）", async () => {
  const { window } = await loadPage();
  const doc = window.document;
  window.navTo("entry");
  window.refreshFundSelect();
  // jsdom 时区=机器时区；断言 toLocaleDateString 口径一致即可
  const d = new Date();
  const want = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  assert.equal(doc.getElementById("tDate").value, want);
});
