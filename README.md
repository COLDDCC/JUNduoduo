# 骏和屋拼单（JUNduoduo）

团员贴骏和屋（駿河屋）商品链接 → 自动列出在售分店和发大阪的运费 → 选店加入 → 首页一眼看到每家店还差多少包邮或均摊达标 → 条件满足立刻给代购发下单邮件。

零 AI token，跑在 Cloudflare 免费额度内（Workers + D1），邮件用 Resend 免费额度。

## 怎么抓取

团员贴的链接只要是同一件商品，结果都一样：

| 团员贴的链接 | 系统做的事 |
| --- | --- |
| `suruga-ya.jp/product/other/120158641` | 取商品编号 `120158641` |
| `suruga-ya.jp/product/detail/120158641?branch_number=0071` | 取同一个编号，并默认选中这条出品（本店 0071） |
| `…/detail/120158641?tenpo_cd=400486&branch_number=0001` | 取同一个编号，默认选中店铺 400486 |

然后读取 `/product/other/{编号}`，这一页列出了全部在售店铺。每条出品的链接里：

- 有 `tenpo_cd` = マケプレ店铺 ID；
- 没有 `tenpo_cd` = 骏和屋本店。

每家店的运费从 `/shop/delivery/{店铺ID}` 读“大阪府”那一行，分两种表：

- 固定运费（例：名古屋乙女館 400 円）；
- 按金额分档（例：不满 2,000 円 550 円，满 2,000 円包邮）。

运费缓存 7 天，团长可在后台手动覆盖。骏和屋本店的运费规则暂按“不满 1,000 円 440、不满 1,500 円 385、满 1,500 円包邮”预设，需团长确认。

解析逻辑集中在 `src/scrape.js`。`test/fixtures/` 里的页面是按已知结构写的合成样例；部署后如果解析有偏差，用后台的“调试：查看骏和屋原始页面”看真实 HTML，再修正。

## 成团规则

一家店一个团，满足任一条件即“可成团”，并给代购邮箱发一封提醒；团长在拼单页点“成团并发邮件”后才锁团、发正式下单邮件。之后团长填入单号，状态变为“已下单”。成团条件：

1. **满额包邮**：商品合计 ≥ 店铺包邮门槛。
2. **均摊全员达标**：运费按件数平分，每个人分到的运费 ≤ 自己填的上限（这一单合计）。

页面上包邮门槛一律按金额显示“还差多少日元包邮”；没有包邮门槛的店显示当前每件运费和超上限的人数。计算在 `public/calc.js`，前端预览和服务器判定共用。

身份：CN + PIN（QQ 号后 4 位），PIN 只存加盐哈希。

隐私：公开页面只显示每人的 CN、件数、金额和运费分摊；商品名、链接、图片只有本人和团长看得到（服务器端过滤，不是前端隐藏）。团员加入或用 CN + QQ 后 4 位“查看我的物品”后，浏览器保存一个签名凭证，之后撤销不用再输 PIN。团长在 `#/admin` 登录后，所有页面都能看到全部物品。成团后团员不能自行撤销，由团长在后台处理。

## 目录

```
public/        手机网页（index.html、app.js、style.css、calc.js）
src/index.js   接口：/api/scrape /api/orders /api/join /api/items/:id/remove /api/admin/*
src/scrape.js  骏和屋页面解析
src/mail.js    成团邮件
src/xlsx.js    导出 Excel（无依赖）
schema.sql     数据库结构
test/          测试（node --test，无需安装依赖）
```

## 部署

Cloudflare 后台 → Workers & Pages → Create → Workers → Import a repository → 选本仓库。Build command 留空，Deploy command 为 `npx wrangler deploy`。之后每次推送到 main 自动部署。

1. Storage & Databases → D1 → Create，名字 `junduoduo`，把 Database ID 填进 `wrangler.toml`。表结构在 Worker 首次访问时自动创建。
2. Worker → Settings → Variables and Secrets，添加 Secret：
   - `ADMIN_KEY`：团长后台口令
   - `PIN_SALT`：任意随机字符串，设好后不要改
   - `RESEND_API_KEY`：可选，不填则成团时不发邮件

网址为 https://junduoduo.toolfavor.com（也可用 workers.dev 地址），团长后台为网址后加 `/#/admin`。

## 使用

- 团员：打开网址，贴链接 → 选店 → 填 CN、QQ 后 4 位、能接受的运费上限 → 加入。
- 团长：访问 `网址/#/admin`，输入 `ADMIN_KEY`。可改代购邮箱、店铺运费、手动成团或关团、移除商品、重发邮件。后台列出全部拼单（含已成团、已下单），每件商品显示 CN、图片和名称。
- 导出 Excel：后台每个拼单、以及团长打开的拼单页都有“导出 Excel”。第 1 页“商品”表头为 `名称 / 图片 / 商品链接 / 平时价格 / 实际价格 / cn`，一件一行（买 2 件就 2 行），商品图直接嵌在单元格里；第 2 页“分账”是每人件数、商品金额、运费分摊和应付。平时价格和实际价格都填加入时的售价。

## 本地开发

```
npm test                  # 跑测试，不需要安装依赖
npx wrangler dev          # 本地预览（需先 npm run db:init:local）
```
