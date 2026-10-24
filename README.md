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

一家店一个团，满足任一条件立刻锁团并发邮件：

1. **满额包邮**：商品合计 ≥ 店铺包邮门槛。
2. **均摊全员达标**：运费按件数平分，每个人分到的运费 ≤ 自己填的上限（这一单合计）。

页面上包邮门槛一律按金额显示“还差多少日元包邮”；没有包邮门槛的店显示当前每件运费和超上限的人数。计算在 `public/calc.js`，前端预览和服务器判定共用。

身份：CN + PIN（QQ 号后 4 位），PIN 只存加盐哈希。成团后团员不能自行撤销，由团长在后台处理。

## 目录

```
public/        手机网页（index.html、app.js、style.css、calc.js）
src/index.js   接口：/api/scrape /api/orders /api/join /api/items/:id/remove /api/admin/*
src/scrape.js  骏和屋页面解析
src/mail.js    成团邮件
schema.sql     数据库结构
test/          测试（node --test，无需安装依赖）
```

## 部署（第一次，约 20 分钟）

1. **建数据库**：Cloudflare 后台 → Storage & Databases → D1 → Create，名字填 `junduoduo`。复制 Database ID，填进 `wrangler.toml` 的 `database_id`。
2. **给 GitHub 部署权限**：Cloudflare → My Profile → API Tokens → Create Token，用“Edit Cloudflare Workers”模板，再加上 D1 Edit 权限。在本仓库 Settings → Secrets and variables → Actions 添加：
   - `CLOUDFLARE_API_TOKEN`：刚建的 Token
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 后台右侧的 Account ID
3. **推送到 main**：GitHub Actions 会自动跑测试、建表、部署。之后每次改代码推送都会自动部署。
4. **设置密钥**：Cloudflare → Workers → junduoduo → Settings → Variables and Secrets，添加（类型选 Secret）：
   - `ADMIN_KEY`：团长后台口令
   - `PIN_SALT`：任意一串随机字符，设好后不要改（改了所有 PIN 会失效）
   - `RESEND_API_KEY`：见下一步
5. **邮件**：注册 [Resend](https://resend.com)，在 Domains 里添加你的域名并按提示加 DNS 记录，创建 API Key。把 `wrangler.toml` 里的 `MAIL_FROM` 改成 `骏和屋拼单 <pin@你的域名>`。未验证域名时只能发给 Resend 注册邮箱本人。
6. **绑定域名（可选）**：Workers → junduoduo → Settings → Domains & Routes → 添加 `pin.你的域名`，并把 `SITE_URL` 设成这个地址。

## 使用

- 团员：打开网址，贴链接 → 选店 → 填 CN、QQ 后 4 位、能接受的运费上限 → 加入。
- 团长：访问 `网址/#/admin`，输入 `ADMIN_KEY`。可改代购邮箱、店铺运费、手动成团或关团、移除商品、重发邮件。

## 本地开发

```
npm test                  # 跑测试，不需要安装依赖
npx wrangler dev          # 本地预览（需先 npm run db:init:local）
```
