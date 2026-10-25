// 骏和屋页面抓取与解析。不依赖任何 AI，只用正则从 HTML 里取需要的字段。
// 骏和屋改版时，只需要改这个文件。

const BASE = 'https://www.suruga-ya.jp';

// 骏和屋本店（无 tenpo_cd 的出品）的店铺 ID 用这个固定值
export const HONTEN_ID = 'honten';

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 从各种骏和屋商品链接里取出商品编号。
 * 支持：/product/other/120158641、/product/detail/120158641?branch_number=0071、
 *       /product/detail/120158641?tenpo_cd=400486&branch_number=0001
 */
export function parseProductId(url) {
  const m = String(url).match(/suruga-ya\.jp\/product\/(?:other|detail)\/([0-9A-Za-z]+)/);
  return m ? m[1] : null;
}

/** 如果链接里带了 tenpo_cd / branch_number，取出来，方便默认选中那家店 */
export function parseListingHint(url) {
  const u = String(url);
  const tenpo = u.match(/tenpo_cd=(\d+)/);
  const branch = u.match(/branch_number=(\d+)/);
  return {
    shopId: tenpo ? tenpo[1] : branch ? HONTEN_ID : null,
    branch: branch ? branch[1] : null,
  };
}

export async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja,zh;q=0.8' },
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) throw new Error(`骏和屋返回 HTTP ${res.status}`);
  return res.text();
}

const decode = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const yen = (s) => {
  const m = String(s).match(/([\d,]+)\s*円/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

/**
 * 解析 /product/other/{id} 页面，返回在售店铺列表。
 * 页面里每条出品都有一个指向 /product/detail/{id}?tenpo_cd=..&branch_number=.. 的链接，
 * 本店出品没有 tenpo_cd。同一条出品可能重复出现（PC/手机两套表格），按 shopId+branch 去重。
 */
export function parseOtherPage(html, productId) {
  const title = parseTitle(html);
  const linkRe = new RegExp(
    `/product/detail/${productId}\\?((?:(?:amp;)?(?:tenpo_cd|branch_number)=\\d+(?:&(?:amp;)?)?)+)`,
    'g',
  );
  const hits = [];
  let m;
  while ((m = linkRe.exec(html))) {
    const query = m[1].replace(/&amp;/g, '&');
    const tenpo = query.match(/(?:^|&)tenpo_cd=(\\d+)/)?.[1] || null;
    const branch = query.match(/(?:^|&)branch_number=(\\d+)/)?.[1] || null;
    hits.push({ idx: m.index, tenpo, branch });
  }

  const seen = new Map();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const key = `${h.tenpo || HONTEN_ID}:${h.branch || ''}`;
    if (seen.has(key)) continue;
    // 这条出品的 HTML 片段：从上一条链接结束到下一条链接开始
    const start = i > 0 ? hits[i - 1].idx : Math.max(0, h.idx - 3000);
    const end = i + 1 < hits.length ? hits[i + 1].idx : h.idx + 3000;
    const chunk = html.slice(start, end);

    const shopId = h.tenpo || HONTEN_ID;
    let shopName = '駿河屋（本店）';
    if (h.tenpo) {
      const nm = chunk.match(new RegExp(`/shop/${h.tenpo}"[^>]*>([\\s\\S]*?)</a>`));
      shopName = nm ? cleanShopName(decode(nm[1])) || `店铺 ${h.tenpo}` : `店铺 ${h.tenpo}`;
    }
    // 价格：在“上一条出品链接 → 这条链接”之间找（骏和屋把价格放在链接前面），
    // 去掉划线原价、定价、买取价、包邮门槛这类数字后取最小值（限时降价时取现价）
    const before = html.slice(start, h.idx);
    const after = html.slice(h.idx, end);
    const price = pickPrice(before) ?? pickPrice(after.slice(0, 1500));
    // 状态：优先取这条链接自身的文字（如“中古帯付き”），否则在片段里找
    const own = (after.match(/^[^>]*>([^<]{0,40})</) || [])[1] || '';
    const cond = (own.match(/(中古.*|新品.*)/) || before.slice(-1500).match(/(中古[^<|｜]{0,30}|新品)/) || [])[1] || null;

    seen.set(key, {
      shopId,
      shopName,
      branch: h.branch,
      price,
      condition: cond ? decode(cond) : null,
      url: `${BASE}/product/detail/${productId}?${[h.tenpo && `tenpo_cd=${h.tenpo}`, h.branch && `branch_number=${h.branch}`].filter(Boolean).join('&')}`,
    });
  }
  const listings = [...seen.values()].sort((a, b) => (a.price ?? 9e9) - (b.price ?? 9e9));
  return { productId, title, image: parseImage(html, productId), listings };
}

/** 单条出品时 branch_number 不存在，用这个占位 */
export const SINGLE_BRANCH = '-';

/**
 * 解析只有一条出品的商品页（店铺独自商品，商品编号带字母，如 ZHORE185731）。
 * 页面里没有 ?tenpo_cd=..&branch_number=.. 链接，只有：
 *   「この商品は、<a href="/shop/200985">某店</a>が販売、発送します。」
 *   「中古 650円 (税込) 在庫数：1」
 */
export function parseSinglePage(html, productId, hint = {}) {
  const title = parseTitle(html);
  const image = parseImage(html, productId);
  const shopLink = /href=["'](?:https?:\/\/www\.suruga-ya\.jp)?\/shop\/(\d+)\/?["'][^>]*>([\s\S]*?)<\/a>/g;
  let shopId = null;
  let shopName = null;
  // 优先取“が販売、発送します”前面那个店铺链接，其次取页面里第一个店铺链接
  const sells = html.search(/が販売(?:、|・)?発送/);
  const links = [...html.matchAll(shopLink)];
  const pickLink = (sells >= 0 ? links.filter((x) => x.index < sells).pop() : null) || links[0];
  if (pickLink) [shopId, shopName] = [pickLink[1], cleanShopName(decode(pickLink[2]))];
  else if (hint.shopId) shopId = hint.shopId;
  else if (sells >= 0 && /駿河屋が販売/.test(html)) shopId = HONTEN_ID;
  if (!shopId) return { productId, title, image, listings: [] };
  if (shopId === HONTEN_ID) shopName = '駿河屋（本店）';
  if (!shopName) shopName = `店铺 ${shopId}`;

  // 价格：“在庫数”前面最近的一个售价；没有在庫数（已售完）就当作不在售
  let price = null;
  let condition = null;
  const stock = html.search(/在庫数/);
  if (stock >= 0) {
    const text = html
      .slice(Math.max(0, stock - 2000), stock)
      .replace(/<(s|del|strike)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    const good = [...text.matchAll(/([\d,]{2,})\s*円/g)].filter(
      (x) => !/定価|買取|参考|送料|ポイント/.test(text.slice(Math.max(0, x.index - 12), x.index)),
    );
    const last = good.at(-1);
    if (last) {
      price = Number(last[1].replace(/,/g, '')) || null;
      const c = text.slice(Math.max(0, last.index - 60), last.index).match(/(中古[^\d|｜]{0,20}?|新品)\s*$/);
      condition = c ? c[1].replace(/\s+/g, ' ').trim() : null;
    }
  }
  const url = `${BASE}/product/detail/${productId}${shopId === HONTEN_ID ? '' : `?tenpo_cd=${shopId}`}`;
  return {
    productId,
    title,
    image,
    listings: [{ shopId, shopName, branch: SINGLE_BRANCH, price, condition, url }],
  };
}

/** 从一段 HTML 里挑出售价 */
export function pickPrice(fragment) {
  const cleaned = String(fragment)
    .replace(/<(s|del|strike)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+class="[^"]*(?:teika|line-through|kaitori|price-teika|text-decoration)[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const vals = [];
  for (const m of cleaned.matchAll(/([\d,]{2,})\s*円/g)) {
    const ctxBefore = cleaned.slice(Math.max(0, m.index - 12), m.index);
    const ctxAfter = cleaned.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (/定価|買取|参考|送料/.test(ctxBefore)) continue;
    if (/^\s*(以上|未満|から|〜|~)/.test(ctxAfter)) continue;
    const v = Number(m[1].replace(/,/g, ''));
    if (v > 0) vals.push(v);
  }
  return vals.length ? Math.min(...vals) : null;
}

function lastYen(s) {
  const all = [...String(s).matchAll(/([\d,]+)\s*円/g)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
}

/** 商品图：优先取 og:image，取不到就用骏和屋商品图的常见地址 */
export function parseImage(html, productId) {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og && /^https?:\/\//.test(og[1]) && !/bgLogo|logo/i.test(og[1])) return og[1].replace(/&amp;/g, '&');
  const img = html.match(new RegExp(`(https://www\\.suruga-ya\\.jp/database/[^"'\\s]*${productId}[^"'\\s]*\\.(?:jpg|png|webp))`));
  return img ? img[1] : `${BASE}/database/photo.php?shinaban=${productId}&size=m`;
}

/** 店名后面常跟着公告（“（全出品アイテム…）●ご注文前に…”），只留店名 */
export function cleanShopName(name) {
  return String(name).split(/[（(●【★※]/)[0].trim();
}

export function parseTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const t = html.match(/<title>([\s\S]*?)<\/title>/);
  const raw = h1 && decode(h1[1]) ? decode(h1[1]) : t ? decode(t[1]).replace(/\s*[|｜:].*$/, '') : null;
  return raw ? raw.replace(/の取り?扱い?店舗一覧$/, '').trim() : null;
}

/**
 * 解析店铺配送页 /shop/delivery/{shopId}，取某个都道府县的运费规则。
 * 返回分档规则 tiers：[{min:0, fee:550}, {min:2000, fee:0}]，按金额从小到大。
 * 两种表格：
 *   1) 店舗都道府県 | 送料              → 固定运费
 *   2) (空) | 2,000円未満 | 2,000円以上 → 按金额分档
 */
export function parseDeliveryPage(html, prefecture = '大阪府') {
  const name = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
  const shopName = name ? decode(name).replace(/\s*≫.*$/, '') : null;

  // 先找收货地那一行，没有就找“全国一律”
  const rowOf = (label) => html.match(new RegExp(`${label}\\s*</t[hd]>([\\s\\S]*?)</tr>`));
  const row = rowOf(prefecture) || rowOf('全国一律');
  if (!row) return { shopName, tiers: null };
  const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => decode(c[1]));

  // 找到这一行所在表格的表头
  const tableStart = html.lastIndexOf('<table', row.index);
  const head = html.slice(tableStart, row.index);
  const headers = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((c) => decode(c[1]));

  const feeOf = (s) => (/無料/.test(s) ? 0 : yen(s));
  if (cells.length <= 1) {
    return { shopName, tiers: [{ min: 0, fee: feeOf(cells[0] || '') }] };
  }
  // 多列：表头形如 “2,000円未満” “2,000円以上”
  const amountHeaders = headers.filter((h) => /円(未満|以上)/.test(h));
  const tiers = cells.map((c, i) => {
    const h = amountHeaders[i] || '';
    const above = h.match(/([\d,]+)円以上/);
    return { min: above ? Number(above[1].replace(/,/g, '')) : 0, fee: feeOf(c) };
  });
  tiers.sort((a, b) => a.min - b.min);
  return { shopName, tiers };
}

/** 只有一家第三方店铺时，/product/other/ 可能直接跳转到该店的详情页。
 * 这种页面没有带 branch_number 的商品链接，因此从店铺身份、库存和当前售价恢复出品。
 */
export function parseSingleShopDetail(html, productId) {
  if (/申し訳ございません。品切れ中です。/.test(html)) return null;
  const shopId = html.match(/(?:[?&]|&amp;)tenpo_cd=(\\d+)/)?.[1] ||
    html.match(/name=["']tenpo_cd["'][^>]*value=["'](\\d+)/i)?.[1] ||
    html.match(/value=["'](\\d+)["'][^>]*name=["']tenpo_cd["']/i)?.[1];
  if (!shopId) return null;
  const stock = html.match(/在庫数\\s*[：:]\\s*(\\d+)/);
  if (stock && Number(stock[1]) <= 0) return null;
  const price = (() => {
    const m = html.match(/(?:中古|新品)[\\s\\S]{0,500}?([\\d,]+)\\s*円\\s*(?:\\(税込\\))?\\s*在庫数/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  })();
  if (price == null) return null;
  const name = html.match(new RegExp(`/shop/${shopId}["'][^>]*>([\\s\\S]*?)<\\/a>`));
  return {
    shopId,
    shopName: name ? cleanShopName(decode(name[1])) : `店铺 ${shopId}`,
    branch: null,
    price,
    condition: null,
    url: `${BASE}/product/detail/${productId}?tenpo_cd=${shopId}`,
  };
}

/** 骏和屋本店的默认运费（需要团长在后台确认，可覆盖） */
export const HONTEN_DEFAULT_TIERS = [
  { min: 0, fee: 440 },
  { min: 1000, fee: 385 },
  { min: 1500, fee: 0 },
];

export async function scrapeProduct(url) {
  const id = parseProductId(url);
  if (!id) throw new Error('不是骏和屋商品链接');
  const html = await fetchHtml(`${BASE}/product/other/${id}`);
  const hint = parseListingHint(url);
  let data = parseOtherPage(html, id);
  // 店铺独自商品（如 ZHORE185731）只有一条出品，/product/other/ 直接显示商品页，没有出品链接
  if (!data.listings.length) data = parseSinglePage(html, id, hint);
  data.hint = hint;
  return data;
}

export async function scrapeShipping(shopId, prefecture) {
  if (shopId === HONTEN_ID) return { shopName: '駿河屋（本店）', tiers: HONTEN_DEFAULT_TIERS };
  const html = await fetchHtml(`${BASE}/shop/delivery/${shopId}`);
  return parseDeliveryPage(html, prefecture);
}
