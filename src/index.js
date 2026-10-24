// 骏和屋拼单 · Cloudflare Worker 入口
// 静态页面由 [assets] 提供（public/），这里只处理 /api/*
import { scrapeProduct, scrapeShipping, fetchHtml, parseProductId, HONTEN_ID } from './scrape.js';
import { evaluate, settle } from './calc.js';
import { buildMail, sendMail } from './mail.js';

const GROUP = 'default';
const SHOP_CACHE_MS = 7 * 24 * 3600 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);
const now = () => Date.now();
const uid = () => crypto.randomUUID();

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const pinHash = (env, cn, pin) => sha256(`${env.PIN_SALT || 'junduoduo'}:${cn}:${pin}`);

async function getGroup(env) {
  let g = await env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(GROUP).first();
  if (!g) {
    await env.DB.prepare(
      'INSERT INTO groups (id, name, prefecture, buyer_email, cc_email, admin_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    )
      .bind(GROUP, env.GROUP_NAME || '骏和屋拼单', env.PREFECTURE || '大阪府', env.BUYER_EMAIL || '', env.CC_EMAIL || null, '-', now())
      .run();
    g = await env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(GROUP).first();
  }
  return g;
}

/** 店铺运费：手动值优先；自动值缓存 7 天，过期重新抓 */
async function getShopTiers(env, shopId, prefecture, fallbackName) {
  const row = await env.DB.prepare('SELECT * FROM shops WHERE shop_id = ? AND prefecture = ?')
    .bind(shopId, prefecture)
    .first();
  if (row && (row.source === 'manual' || now() - row.updated_at < SHOP_CACHE_MS) && row.tiers) {
    return { name: row.name, tiers: JSON.parse(row.tiers), source: row.source };
  }
  try {
    const r = await scrapeShipping(shopId, prefecture);
    const name = r.shopName || fallbackName || row?.name || shopId;
    await env.DB.prepare(
      `INSERT INTO shops (shop_id, prefecture, name, tiers, source, updated_at) VALUES (?,?,?,?, 'auto', ?)
       ON CONFLICT(shop_id, prefecture) DO UPDATE SET name=excluded.name, tiers=excluded.tiers, updated_at=excluded.updated_at
       WHERE shops.source = 'auto'`,
    )
      .bind(shopId, prefecture, name, r.tiers ? JSON.stringify(r.tiers) : null, now())
      .run();
    return { name, tiers: r.tiers, source: 'auto' };
  } catch (e) {
    if (row?.tiers) return { name: row.name, tiers: JSON.parse(row.tiers), source: row.source, stale: true };
    return { name: fallbackName || shopId, tiers: null, source: 'none', error: String(e.message || e) };
  }
}

/** 读取一个拼单的全部数据并计算进度 */
async function loadOrder(env, order, prefecture) {
  const { results: items } = await env.DB.prepare(
    `SELECT items.*, members.cn FROM items JOIN members ON members.id = items.member_id
     WHERE order_id = ? AND removed_at IS NULL ORDER BY items.created_at`,
  )
    .bind(order.id)
    .all();
  const { results: capRows } = await env.DB.prepare(
    'SELECT members.cn, caps.cap FROM caps JOIN members ON members.id = caps.member_id WHERE order_id = ?',
  )
    .bind(order.id)
    .all();
  const caps = Object.fromEntries(capRows.map((c) => [c.cn, c.cap]));
  const shop = await getShopTiers(env, order.shop_id, prefecture, order.shop_name);
  const tiers = order.fee_override ? JSON.parse(order.fee_override) : shop.tiers;
  const result = evaluate({
    items: items.map((i) => ({ member: i.cn, price: i.price, qty: i.qty })),
    caps,
    tiers: tiers || [{ min: 0, fee: 0 }],
  });
  return {
    order: { ...order, shop_name: order.shop_name || shop.name },
    tiers,
    tiersSource: order.fee_override ? 'order' : shop.source,
    items: items.map(({ member_id, ...i }) => i),
    result,
    settle: settle(result),
  };
}

async function finalize(env, group, data, siteUrl) {
  const { order } = data;
  await env.DB.prepare("UPDATE orders SET status='done', done_at=? WHERE id=? AND status='open'")
    .bind(now(), order.id)
    .run();
  const mail = buildMail({ ...data, siteUrl });
  const status = group.buyer_email
    ? await sendMail(env, { to: group.buyer_email, cc: group.cc_email, ...mail })
    : 'failed:未设置代购邮箱';
  await env.DB.prepare('UPDATE orders SET mail_status=? WHERE id=?').bind(status, order.id).run();
  return status;
}

async function isAdmin(req, env) {
  const key = req.headers.get('X-Admin-Key');
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}

async function body(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function api(req, env, url) {
  const p = url.pathname;
  const m = req.method;
  const group = await getGroup(env);
  const pref = group.prefecture;
  const site = env.SITE_URL || url.origin;

  // 贴链接：返回商品、在售店铺、每家店的运费与当前拼单进度
  if (p === '/api/scrape' && m === 'GET') {
    const link = url.searchParams.get('url') || '';
    if (!parseProductId(link)) return fail('请贴骏和屋商品链接（suruga-ya.jp/product/...）');
    let data;
    try {
      data = await scrapeProduct(link);
    } catch (e) {
      return fail(`读取骏和屋失败：${e.message}`, 502);
    }
    const shops = await Promise.all(
      data.listings.map(async (l) => {
        const shop = await getShopTiers(env, l.shopId, pref, l.shopName);
        const open = await env.DB.prepare(
          "SELECT * FROM orders WHERE group_id=? AND shop_id=? AND status='open' LIMIT 1",
        )
          .bind(GROUP, l.shopId)
          .first();
        const progress = open ? (await loadOrder(env, open, pref)).result : null;
        return { ...l, tiers: shop.tiers, tiersSource: shop.source, tiersError: shop.error, openOrderId: open?.id || null, progress };
      }),
    );
    return json({ productId: data.productId, title: data.title, image: data.image, hint: data.hint, prefecture: pref, listings: shops });
  }

  // 首页：正在拼 + 最近成团
  if (p === '/api/orders' && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM orders WHERE group_id=? AND (status='open' OR (status='done' AND done_at > ?))
       ORDER BY status='open' DESC, created_at DESC`,
    )
      .bind(GROUP, now() - 3 * 24 * 3600 * 1000)
      .all();
    const list = await Promise.all(results.map((o) => loadOrder(env, o, pref)));
    return json({ prefecture: pref, orders: list.filter((o) => o.items.length || o.order.status !== 'open') });
  }

  let mm;
  if ((mm = p.match(/^\/api\/orders\/([\w-]+)$/)) && m === 'GET') {
    const o = await env.DB.prepare('SELECT * FROM orders WHERE id=? AND group_id=?').bind(mm[1], GROUP).first();
    if (!o) return fail('找不到这个拼单', 404);
    return json(await loadOrder(env, o, pref));
  }

  // 加入拼单
  if (p === '/api/join' && m === 'POST') {
    const b = await body(req);
    const cn = String(b.cn || '').trim();
    const pin = String(b.pin || '').trim();
    const qty = Math.max(1, Math.min(20, parseInt(b.qty, 10) || 1));
    const cap = Math.max(0, parseInt(b.cap, 10) || 0);
    if (!cn || cn.length > 20) return fail('请填写 CN（20 字以内）');
    if (!/^\d{4}$/.test(pin)) return fail('PIN 是 QQ 号后 4 位数字');
    const productId = parseProductId(b.url);
    if (!productId || !b.shopId || !b.branch) return fail('缺少商品或店铺信息');

    // 价格以服务器重新抓到的为准，防止前端篡改
    let product;
    try {
      product = await scrapeProduct(b.url);
    } catch (e) {
      return fail(`读取骏和屋失败：${e.message}`, 502);
    }
    const listing = product.listings.find((l) => l.shopId === b.shopId && l.branch === b.branch);
    if (!listing || listing.price == null) return fail('这家店的这件商品已下架或读不到价格');

    // 成员：CN 第一次出现就创建；之后必须 PIN 一致
    const hash = await pinHash(env, cn, pin);
    let member = await env.DB.prepare('SELECT * FROM members WHERE group_id=? AND cn=?').bind(GROUP, cn).first();
    if (member && member.pin_hash !== hash) return fail('这个 CN 已存在，PIN 不对', 403);
    if (!member) {
      member = { id: uid() };
      await env.DB.prepare('INSERT INTO members (id, group_id, cn, pin_hash, created_at) VALUES (?,?,?,?,?)')
        .bind(member.id, GROUP, cn, hash, now())
        .run();
    }

    let order = await env.DB.prepare("SELECT * FROM orders WHERE group_id=? AND shop_id=? AND status='open' LIMIT 1")
      .bind(GROUP, b.shopId)
      .first();
    if (!order) {
      order = { id: uid() };
      await env.DB.prepare('INSERT INTO orders (id, group_id, shop_id, shop_name, status, created_at) VALUES (?,?,?,?,?,?)')
        .bind(order.id, GROUP, b.shopId, listing.shopName, 'open', now())
        .run();
    }
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO items (id, order_id, member_id, product_id, url, title, image, price, qty, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(uid(), order.id, member.id, productId, listing.url, product.title, product.image, listing.price, qty, now()),
      env.DB.prepare(
        'INSERT INTO caps (order_id, member_id, cap) VALUES (?,?,?) ON CONFLICT(order_id, member_id) DO UPDATE SET cap=excluded.cap',
      ).bind(order.id, member.id, cap),
    ]);

    const full = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(order.id).first();
    const data = await loadOrder(env, full, pref);
    if (data.result.success) {
      data.mailStatus = await finalize(env, group, data, site);
      data.order.status = 'done';
    }
    return json(data);
  }

  // 团员撤销自己的物品（成团后不能自行撤销）
  if ((mm = p.match(/^\/api\/items\/([\w-]+)\/remove$/)) && m === 'POST') {
    const b = await body(req);
    const item = await env.DB.prepare(
      `SELECT items.*, members.cn, members.pin_hash, orders.status FROM items
       JOIN members ON members.id = items.member_id JOIN orders ON orders.id = items.order_id
       WHERE items.id=? AND items.removed_at IS NULL`,
    )
      .bind(mm[1])
      .first();
    if (!item) return fail('找不到这件商品', 404);
    if (item.status !== 'open') return fail('已成团，撤销请联系团长', 409);
    if (item.pin_hash !== (await pinHash(env, item.cn, String(b.pin || '')))) return fail('PIN 不对', 403);
    await env.DB.prepare("UPDATE items SET removed_at=?, removed_by='self' WHERE id=?").bind(now(), item.id).run();
    const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(item.order_id).first();
    return json(await loadOrder(env, o, pref));
  }

  // ---------- 团长后台 ----------
  if (p.startsWith('/api/admin/')) {
    if (!(await isAdmin(req, env))) return fail('管理口令不对', 401);

    if (p === '/api/admin/group' && m === 'GET') return json({ ...group, admin_hash: undefined });
    if (p === '/api/admin/group' && m === 'PUT') {
      const b = await body(req);
      await env.DB.prepare('UPDATE groups SET buyer_email=?, cc_email=?, prefecture=? WHERE id=?')
        .bind(b.buyer_email ?? group.buyer_email, b.cc_email ?? group.cc_email, b.prefecture ?? group.prefecture, GROUP)
        .run();
      return json({ ok: true });
    }

    // 改店铺运费（手动值优先于自动抓取）；tiers 传 null 恢复自动
    if ((mm = p.match(/^\/api\/admin\/shops\/([\w-]+)$/)) && m === 'PUT') {
      const b = await body(req);
      if (b.tiers === null) {
        await env.DB.prepare("DELETE FROM shops WHERE shop_id=? AND prefecture=?").bind(mm[1], pref).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO shops (shop_id, prefecture, name, tiers, source, updated_at) VALUES (?,?,?,?, 'manual', ?)
           ON CONFLICT(shop_id, prefecture) DO UPDATE SET tiers=excluded.tiers, source='manual', updated_at=excluded.updated_at,
           name=COALESCE(excluded.name, shops.name)`,
        )
          .bind(mm[1], pref, b.name || null, JSON.stringify(b.tiers), now())
          .run();
      }
      return json({ ok: true });
    }

    // 拼单操作：close 关团 / done 手动成团 / reopen 重新打开 / resend 重发邮件 / fee 本团单独运费
    if ((mm = p.match(/^\/api\/admin\/orders\/([\w-]+)\/(close|done|reopen|resend|fee)$/)) && m === 'POST') {
      const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(mm[1]).first();
      if (!o) return fail('找不到这个拼单', 404);
      const act = mm[2];
      if (act === 'close') await env.DB.prepare("UPDATE orders SET status='closed' WHERE id=?").bind(o.id).run();
      if (act === 'reopen') await env.DB.prepare("UPDATE orders SET status='open', done_at=NULL WHERE id=?").bind(o.id).run();
      if (act === 'fee') {
        const b = await body(req);
        await env.DB.prepare('UPDATE orders SET fee_override=? WHERE id=?')
          .bind(b.tiers ? JSON.stringify(b.tiers) : null, o.id)
          .run();
      }
      if (act === 'done' || act === 'resend') {
        const data = await loadOrder(env, { ...o, status: 'open' }, pref);
        if (act === 'resend') await env.DB.prepare("UPDATE orders SET status='open' WHERE id=?").bind(o.id).run();
        const status = await finalize(env, group, data, site);
        return json({ ok: true, mailStatus: status });
      }
      return json({ ok: true });
    }

    if ((mm = p.match(/^\/api\/admin\/items\/([\w-]+)$/)) && m === 'DELETE') {
      await env.DB.prepare("UPDATE items SET removed_at=?, removed_by='admin' WHERE id=?").bind(now(), mm[1]).run();
      return json({ ok: true });
    }

    if (p === '/api/admin/members/reset-pin' && m === 'POST') {
      const b = await body(req);
      if (!/^\d{4}$/.test(String(b.pin))) return fail('PIN 必须是 4 位数字');
      await env.DB.prepare('UPDATE members SET pin_hash=? WHERE group_id=? AND cn=?')
        .bind(await pinHash(env, b.cn, String(b.pin)), GROUP, b.cn)
        .run();
      return json({ ok: true });
    }

    // 调试：查看骏和屋原始 HTML 片段，用于骏和屋改版后修正解析
    if (p === '/api/admin/debug/raw' && m === 'GET') {
      const target = url.searchParams.get('url');
      if (!/^https:\/\/www\.suruga-ya\.jp\//.test(target || '')) return fail('只允许骏和屋链接');
      const html = await fetchHtml(target);
      const q = url.searchParams.get('find');
      const at = q ? html.indexOf(q) : 0;
      return new Response(html.slice(Math.max(0, at - 1500), at + 4000), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  return fail('未知接口', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(req, env, url);
      } catch (e) {
        return fail(`服务器出错：${e.message}`, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};

export { HONTEN_ID };
