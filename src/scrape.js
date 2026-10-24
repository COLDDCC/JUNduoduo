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
    `/product/detail/${productId}\\?(?:tenpo_cd=(\\d+)&(?:amp;)?)?branch_number=(\\d+)`,
    'g',
  );
  const hits = [];
  let m;
  while ((m = linkRe.exec(html))) hits.push({ idx: m.index, tenpo: m[1] || null, branch: m[2] });

  const seen = new Map();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const key = `${h.tenpo || HONTEN_ID}:${h.branch}`;
    if (seen.has(key)) continue;
    // 这条出品的 HTML 片段：从上一条链接结束到下一条链接开始
    const start = i > 0 ? hits[i - 1].idx : Math.max(0, h.idx - 3000);
    const end = i + 1 < hits.length ? hits[i + 1].idx : h.idx + 3000;
    const chunk = html.slice(start, end);

    const shopId = h.tenpo || HONTEN_ID;
    let shopName = '駿河屋（本店）';
    if (h.tenpo) {
      const nm = chunk.match(new RegExp(`/shop/${h.tenpo}"[^>]*>([\\s\\S]*?)</a>`));
      shopName = nm ? decode(nm[1]) || `店铺 ${h.tenpo}` : `店铺 ${h.tenpo}`;
    }
    // 价格：取片段里离链接最近的“xxx円”（片段后半部分优先）
    const after = html.slice(h.idx, end);
    const before = html.slice(start, h.idx);
    const price = yen(after) ?? lastYen(before);
    // 状态：优先取这条链接自身的文字（如“中古帯付き”），否则在片段后半部分找
    const own = (after.match(/^[^>]*>([^<]{0,40})</) || [])[1] || '';
    const cond = (own.match(/(中古.*|新品.*)/) || after.match(/(中古[^<|｜]{0,30}|新品)/) || [])[1] || null;

    seen.set(key, {
      shopId,
      shopName,
      branch: h.branch,
      price,
      condition: cond ? decode(cond) : null,
      url: `${BASE}/product/detail/${productId}?${h.tenpo ? `tenpo_cd=${h.tenpo}&` : ''}branch_number=${h.branch}`,
    });
  }
  const listings = [...seen.values()].sort((a, b) => (a.price ?? 9e9) - (b.price ?? 9e9));
  return { productId, title, image: parseImage(html, productId), listings };
}

function lastYen(s) {
  const all = [...String(s).matchAll(/([\d,]+)\s*円/g)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
}

/** 商品图：优先取 og:image，取不到就用骏和屋商品图的常见地址 */
export function parseImage(html, productId) {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og && /^https?:\/\//.test(og[1])) return og[1].replace(/&amp;/g, '&');
  const img = html.match(new RegExp(`(https://www\\.suruga-ya\\.jp/database/[^"'\\s]*${productId}[^"'\\s]*\\.(?:jpg|png|webp))`));
  return img ? img[1] : `${BASE}/database/pics_light/game/${productId}.jpg`;
}

export function parseTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (h1 && decode(h1[1])) return decode(h1[1]);
  const t = html.match(/<title>([\s\S]*?)<\/title>/);
  return t ? decode(t[1]).replace(/\s*[|｜:].*$/, '') : null;
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

  const rowRe = new RegExp(`${prefecture}\\s*</t[hd]>([\\s\\S]*?)</tr>`);
  const row = html.match(rowRe);
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
  const data = parseOtherPage(html, id);
  data.hint = parseListingHint(url);
  return data;
}

export async function scrapeShipping(shopId, prefecture) {
  if (shopId === HONTEN_ID) return { shopName: '駿河屋（本店）', tiers: HONTEN_DEFAULT_TIERS };
  const html = await fetchHtml(`${BASE}/shop/delivery/${shopId}`);
  return parseDeliveryPage(html, prefecture);
}
