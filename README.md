# 基金板块分析（GitHub 云端版）

纯静态基金持仓板块分析工具，托管在 GitHub Pages，手机/电脑任意网络可用，**不依赖家里电脑开机**。

## 数据边界（隐私设计）

| 数据 | 位置 | 说明 |
|---|---|---|
| 基金代码/名称/兜底大类 | `data/funds.json`（仓库） | 公开信息，不含金额 |
| 行业构成/净值历史 | `data/market.json`（Action 自动生成） | 公开市场数据 |
| **金额/交易记录** | **浏览器 localStorage（仅本机）** | 不上传，换设备用导出/导入迁移 |
| GitHub Token / 智谱 key | localStorage | 只存本机 |

## 数据流

1. **录入**（网页"录入"页）：输入 6 位代码 → 东财接口即时查名 → 保存
   （新基金写入仓库 `data/funds.json`；金额只存本机）
2. **数据更新**：GitHub Action 每个交易日 22:30（北京时间）+ push 触发，
   抓取每只基金前十大重仓股 → 个股细分行业（按占净值比加权）→ 近40日净值，
   生成 `data/market.json`
3. **分析**（网页"总览"页）：金额 × 真实行业构成 → 组合板块占比（非名称推断）；
   净值加权算今日/近30天/最大回撤/日波动

## 使用

- 手机：浏览器打开 Pages 地址 → 分享 → 添加到主屏幕（PWA）
- 图片识别：智谱 GLM 视觉模型（设置页填 key，推荐免费模型 glm-4.5v-flash）
- 语音识别：Safari 内置（Web Speech API）

## 文件

```
index.html                     单页应用（总览/录入/明细/设置）
scripts/update_data.py         数据抓取（Action 运行，也可本地跑）
.github/workflows/update-data.yml  定时更新
data/funds.json                基金清单（录入产生）
data/market.json               行业+净值（Action 生成，勿手改）
```
