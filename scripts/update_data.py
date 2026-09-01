#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取每只持仓基金的真实行业构成 + 净值历史，生成 data/market.json。

数据源（东方财富公开接口）：
  - FundMNDetailInformation : 基金名称 / 类型
  - FundMNInverstPosition   : 前十大重仓股（代码、名称、TEXCH市场、JZBL占净值比%）
  - push2 stock/get f127    : 个股细分行业（如"白酒Ⅱ""半导体"）
  - f10/lsjz                : 近40日净值（DWJZ）与日涨跌（JZZZL）

行业构成 = Σ(重仓股 JZBL 按其细分行业累加)；差额部分记为"未披露/其他"。
黄金/货币/纯海外等无A股重仓的基金 industries 为空 → 前端按用户选的兜底大类入桶。

用法: python3 scripts/update_data.py
"""
import json
import sys
import time
import datetime
import urllib.request
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FUNDS_FILE = ROOT / "data" / "funds.json"
MARKET_FILE = ROOT / "data" / "market.json"

UA = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      "Referer": "http://fundf10.eastmoney.com/"}
MOB = "https://fundmobapi.eastmoney.com/FundMNewApi"
NAV_DAYS = 40          # 净值历史条数，支撑近30天波动指标
STOCK_SLEEP = 0.25     # 个股行业查询间隔，礼貌抓取
FUND_SLEEP = 0.5


def get_json(url: str, timeout: int = 10):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_fund_meta(code: str) -> dict:
    d = get_json(f"{MOB}/FundMNDetailInformation?FCODE={code}"
                 "&deviceid=1&plat=Iphone&product=EFund&version=6.2.5")
    datas = d.get("Datas") or {}
    return {"name": datas.get("SHORTNAME", ""), "type": datas.get("FTYPE", "")}


def stock_industry(stock_code: str, texch: str) -> str:
    """个股细分行业。fundmobapi 的 TEXCH: 1=沪 2=深；push2 secid: 1=沪 0=深 116=港 105/106=美。
    港美股 push2 也认，取不到行业则归海外。"""
    push_secid = {"1": "1", "2": "0"}.get(texch, texch)
    try:
        d = get_json(f"https://push2delay.eastmoney.com/api/qt/stock/get"
                     f"?secid={push_secid}.{stock_code}&fields=f127")
        name = (d.get("data") or {}).get("f127")
        if name:
            return name
    except Exception:
        pass
    return "海外/其他" if texch not in ("1", "2") else "其他"


def fetch_industries(code: str) -> dict:
    """返回 {行业: 占净值比%}，基于前十大重仓股的真实行业。"""
    d = get_json(f"{MOB}/FundMNInverstPosition?FCODE={code}"
                 "&deviceid=1&plat=Iphone&product=EFund&version=6.2.5")
    stocks = (d.get("Datas") or {}).get("fundStocks") or []
    industries, total = {}, 0.0
    for s in stocks:
        try:
            weight = float(s.get("JZBL") or 0)
        except (TypeError, ValueError):
            continue
        if weight <= 0:
            continue
        ind = stock_industry(s.get("GPDM", ""), s.get("TEXCH", ""))
        industries[ind] = round(industries.get(ind, 0) + weight, 2)
        total += weight
        time.sleep(STOCK_SLEEP)
    if industries:
        residual = round(100 - total, 2)   # 未进前十大的部分（现金/债券/其他股票）
        industries["未披露/其他"] = max(residual, 0)
    return industries


def fetch_nav_history(code: str) -> list:
    """lsjz 每页封顶20条，翻页取满 NAV_DAYS 天。"""
    out = []
    for page in (1, 2):
        d = get_json(f"https://api.fund.eastmoney.com/f10/lsjz"
                     f"?fundCode={code}&pageIndex={page}&pageSize=20")
        rows = ((d.get("Data") or {}).get("LSJZList")) or []
        for r in rows:
            try:
                out.append({"d": r["FSRQ"],
                            "nav": float(r["DWJZ"]),
                            "pct": None if r.get("JZZZL") in (None, "")
                                   else float(r["JZZZL"])})
            except (KeyError, TypeError, ValueError):
                continue
        if len(out) >= NAV_DAYS or not rows:
            break
    return list(reversed(out[-NAV_DAYS:]))   # 时间升序，方便直接画线


def main() -> int:
    funds = json.loads(FUNDS_FILE.read_text("utf-8")) if FUNDS_FILE.exists() else []
    if isinstance(funds, dict):
        funds = funds.get("funds", [])
    codes = [f["code"] for f in funds]

    market = {"updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
              "funds": {}}
    if MARKET_FILE.exists():
        try:   # 保留旧数据：某只抓取失败时沿用上次结果
            old = json.loads(MARKET_FILE.read_text("utf-8"))
            market["funds"] = old.get("funds", {})
        except (json.JSONDecodeError, OSError):
            pass

    errors = []
    for code in codes:
        try:
            info = market["funds"].get(code, {})
            info.update(fetch_fund_meta(code))
            info["industries"] = fetch_industries(code)
            nav = fetch_nav_history(code)
            if nav:
                info["nav_history"] = nav
            market["funds"][code] = info
            print(f"OK  {code} {info.get('name','')} "
                  f"行业{len(info['industries'])}项 净值{len(nav)}天")
        except Exception as e:   # 单只失败不影响整体
            errors.append(f"{code}: {e}")
            print(f"ERR {code}: {e}", file=sys.stderr)
        time.sleep(FUND_SLEEP)

    MARKET_FILE.write_text(json.dumps(market, ensure_ascii=False, indent=1),
                           "utf-8")
    print(f"done: {len(market['funds'])} funds, {len(errors)} errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
