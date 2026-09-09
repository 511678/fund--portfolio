/* 纯逻辑层：不含 DOM/网络。浏览器端挂在 FP 全局（index.html 先于主脚本加载），
   Node 端 module.exports 供 tests/ 使用（node --test）。 */
(function (g) {
  "use strict";

  /* 申万细分行业 → 板块（顺序匹配，靠前者优先） */
  const INDUSTRY_RULES = [
    [/贵金属|黄金|金银/, "黄金"],
    [/海外|港股|美股|纳斯达克|标普|日经|新兴市场|亚洲|全球/, "海外QDII"],
    [/半导体|芯片|集成电路|元件|PCB|印制电路|被动元件|分立器件|电子化学品|光学光电子|消费电子|电子|光模块|通信|计算机|软件|互联网|云计算|IT服务|人工智能|算力|游戏|传媒|数字媒体|影视|出版|广告营销/, "信息技术"],
    [/电池|光伏|风电|电源|电网|储能|电力设备|锂电|机械设备|自动化|机器人|军工|国防|航天|航空装备|汽车|乘用车|商用车|摩托车/, "先进制造"],
    [/医药|医疗|生物|中药|制药|疫苗|CXO|医疗服务/, "医药"],
    [/银行|证券|保险|信托|多元金融|金融/, "金融"],
    [/钢铁|化工|化学|塑料|橡胶|化纤|有色|能源金属|小金属|工业金属|金属新材料|煤炭|石油|石化|炼化|油服|水泥|玻璃|建材|建筑材料|环保|肥料|农化/, "周期资源"],
    [/房地产|建筑|装饰|交通运输|公路|铁路|航空|机场|港口|航运|物流|公用事业|电力|燃气|水务/, "基建地产"],
    [/白酒|酿酒|啤酒|乳品|食品|饮料|调味|零食|保健品|家电|家用电器|照明|厨卫|美容护理|化妆品|个护|纺织|服装|服饰|商贸|零售|旅游|酒店|餐饮|教育|社会服务|轻工|造纸|包装|家居|农林牧渔|种植|养殖|畜牧|饲料|渔业|宠物/, "消费"],
    [/^未披露\/其他$/, "未披露"],
  ];

  function bucketOf(industry) {
    for (const [re, b] of INDUSTRY_RULES) if (re.test(industry)) return b;
    return "综合";
  }

  /* 主板块：industries = {行业: 占净值比%}，fallback = 无行业数据时的兜底板块。
     同占值并列时取先遍历到的板块。 */
  function fundMainBucket(industries, fallback) {
    const inds = Object.entries(industries || {});
    if (!inds.length) return {bucket: fallback, sub: ""};
    const agg = {};
    let best = "综合", bv = -1;
    for (const [ind, w] of inds) {
      const b = bucketOf(ind);
      agg[b] = (agg[b] || 0) + w;
      if (agg[b] > bv) { bv = agg[b]; best = b; }
    }
    const top = inds.slice().sort((a, b) => b[1] - a[1])[0][0];
    return {bucket: best, sub: top};
  }

  /* HTML 转义：所有进入 innerHTML / 属性插值的第三方数据（接口基金名、
     截图识别结果、语音文本）必须过这里。 */
  const esc = s => String(s ?? "").replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  /* 本地时区日期。toISOString 是 UTC，北京时间 0~8 点会差一天。 */
  function todayLocal(now = new Date()) {
    const p = n => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  }

  /* 静态净值日期是否新鲜：日历日差不超过 4 天（覆盖周末+短假期），
     允许未来 1 个日历日（对端时区偏差）。market.json 停更时防止
     几十天前的涨幅冒充"今日"。 */
  function isFreshNav(dateStr, now = new Date()) {
    if (!dateStr) return false;
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return false;
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((day0 - d) / 864e5);
    return days <= 4 && days >= -1;
  }

  const core = { INDUSTRY_RULES, bucketOf, fundMainBucket, esc, todayLocal, isFreshNav };

  /* ============ 账本（成本/盈亏） ============
     amounts[c] = {amt 市值快照, cost 累计投入成本, d 快照对应净值日 YYYY-MM-DD}
     盈亏 = amt − cost；cost 未录 = null（不参与组合盈亏，不显示误导性 0）。 */

  const round2 = n => Math.round(n * 100) / 100;

  /* 快照市值滚到最新净值日：对 nav 中日期 > fromDate 的每日涨跌累乘。
     fromDate 早于数据起点则滚可见段；无更新（fromDate ≥ 最新日）返回 null。 */
  function rollFactor(nav, fromDate) {
    if (!Array.isArray(nav) || !nav.length || !fromDate) return null;
    const lastD = nav[nav.length - 1].d;
    if (fromDate >= lastD) return null;
    let f = 1;
    for (const p of nav) {
      if (p.d > fromDate && p.pct != null) f *= 1 + p.pct / 100;
    }
    return f === 1 ? null : f;
  }

  /* 滚动后的市值（无更新或不可滚则原值） */
  function rolledAmt(amt, nav, fromDate) {
    const f = rollFactor(nav, fromDate);
    return f == null ? amt : round2(amt * f);
  }

  /* 开账：新基金未填成本时按市值开账（盈亏从入账日起算） */
  const openBook = amt => round2(amt);

  /* 买入/加仓/定投：追加投入 → 成本与市值同增 */
  function applyBuy(cost, amt, add) {
    return {cost: round2((cost || 0) + add), amt: round2(amt + add)};
  }

  /* 卖出/减仓：成本按「卖出额 ÷ 卖出前市值」比例摊减（平均成本近似）。
     cost 未录(null) 时保持 null——不知道成本就不能凭空造出 0 成本。 */
  function applySell(cost, amt, sell) {
    const p = amt > 0 ? Math.min(sell / amt, 1) : 1;
    return {
      cost: cost == null ? null : round2(cost * (1 - p)),
      amt: Math.max(round2(amt - sell), 0),
    };
  }

  /* 每基金持有收益口径：cost 缺失 → {pnl:null} */
  function pnlOf(amtCur, cost) {
    if (cost == null || cost < 0) return {pnl: null, pct: null};
    const pnl = round2(amtCur - cost);
    return {pnl, pct: cost > 0 ? round2(pnl / cost * 100) : 0};
  }

  Object.assign(core, {round2, rollFactor, rolledAmt, openBook, applyBuy, applySell, pnlOf});
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  else g.FP = Object.assign({}, g.FP, core);
})(typeof window !== "undefined" ? window : globalThis);
