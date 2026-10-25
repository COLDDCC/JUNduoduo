// 用 Node 自带的 SQLite 模拟 D1，把加入 → 撤销 → 成团发邮件整条流程跑一遍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

// 1×1 PNG，模拟商品图
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/product/other/ZHORE')) return new Response(fx('single.html'));
  if (u.includes('/product/other/')) return new Response(fx('other.html'));
  if (u.includes('/shop/delivery/')) return new Response(fx('delivery-fixed.html'));
  if (u.includes('/database/')) return new Response(PNG);
  if (u.includes('api.resend.com')) {
    sent.push(JSON.parse(opts.body));
    return new Response('{"id":"x"}');
  }
  return new Response('not found', { status: 404 });
};

const env = {
  DB: makeD1(),
  BUYER_EMAIL: 'buyer@example.com',
  PREFECTURE: '大阪府',
  ADMIN_KEY: 'admin',
  RESEND_API_KEY: 'test',
  ASSETS: { fetch: () => new Response('page') },
};
const call = async (path, method = 'GET', body, headers = {}) => {
  const res = await worker.fetch(
    new Request(`https://pin.example.com${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );
  return { status: res.status, data: await res.json() };
};
const LINK = 'https://www.suruga-ya.jp/product/detail/120158641?tenpo_cd=400486&branch_number=0001';
const join = (cn, pin, cap, qty = 1) =>
  call('/api/join', 'POST', { url: LINK, shopId: '400486', branch: '0001', cn, pin, cap, qty });

test('贴链接返回店铺、运费、进度', async () => {
  const { status, data } = await call(`/api/scrape?url=${encodeURIComponent(LINK)}`);
  assert.equal(status, 200);
  assert.equal(data.listings.length, 4);
  assert.deepEqual(data.hint, { shopId: '400486', branch: '0001' });
  assert.deepEqual(data.listings[0].tiers, [{ min: 0, fee: 400 }]);
  assert.equal(data.listings[0].progress, null);
});

test('完整流程：加入、PIN 校验、撤销、成团发邮件', async () => {
  let r = await join('阿柚', '1234', 150);
  assert.equal(r.status, 200);
  assert.equal(r.data.result.count, 1);

  r = await join('阿柚', '9999', 150);
  assert.equal(r.status, 403, '同一 CN 换 PIN 应被拒');

  r = await join('小鹿', '5678', 100);
  const itemId = r.data.items.find((i) => i.cn === '小鹿').id;
  assert.equal(r.data.result.overCount, 2); // 2 件时每件 200，两人都超上限

  r = await call(`/api/items/${itemId}/remove`, 'POST', { pin: '0000' });
  assert.equal(r.status, 403, '错误 PIN 不能撤销');
  r = await call(`/api/items/${itemId}/remove`, 'POST', { pin: '5678' });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.count, 1);

  await join('小鹿', '5678', 100);
  await join('糯米', '2468', 150);
  assert.equal(sent.length, 0);
  r = await join('七七', '1357', 100);
  // 满足条件不自动成团：保持拼单中，给团长发一封“可成团”提醒
  assert.equal(r.data.result.success, true);
  assert.equal(r.data.order.status, 'open');
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /可成团/);
  // 仍满足条件时再加人，不会重复提醒
  r = await join('八八', '8888', 1000);
  assert.equal(r.data.result.success, true);
  assert.equal(sent.length, 1);
  await call(`/api/items/${r.data.items[0].id}/remove`, 'POST', {}, { 'X-Member-Token': r.data.token });
  assert.equal(sent.length, 1);

  // 团长确认成团 → 发正式下单邮件
  const okRes = await call(`/api/admin/orders/${r.data.order.id}/done`, 'POST', {}, { 'X-Admin-Key': 'admin' });
  assert.equal(okRes.data.mailStatus, 'sent');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].to, ['buyer@example.com']);
  assert.match(sent[1].html, /tenpo_cd=400486/);

  const list = await call('/api/orders');
  assert.equal(list.data.orders.length, 1);
  assert.equal(list.data.orders[0].order.status, 'done');

  // 成团后不能自己撤销
  // 路人看不到任何物品，团长能看到全部
  assert.equal(list.data.orders[0].items.length, 0);
  const adminList = await call('/api/orders', 'GET', null, { 'X-Admin-Key': 'admin' });
  assert.equal(adminList.data.orders[0].items.length, 4);
  const any = adminList.data.orders[0].items[0].id;
  r = await call(`/api/items/${any}/remove`, 'POST', { pin: '1234' });
  assert.equal(r.status, 409);

  // 团长填单号 → 已下单
  const oid = adminList.data.orders[0].order.id;
  let o2 = await call(`/api/admin/orders/${oid}/ordered`, 'POST', { orderNo: 'SR-20261025-001' }, { 'X-Admin-Key': 'admin' });
  assert.equal(o2.status, 200);
  assert.equal(o2.data.order.status, 'ordered');
  assert.equal(o2.data.order.order_no, 'SR-20261025-001');
  o2 = await call(`/api/admin/orders/${oid}/ordered`, 'POST', { orderNo: '' }, { 'X-Admin-Key': 'admin' });
  assert.equal(o2.status, 400);
  assert.equal((await call(`/api/admin/orders/${oid}/ordered`, 'POST', { orderNo: 'x' })).status, 401);

});

test('隐私：只有本人看得到自己的物品', async () => {
  const L2 = 'https://www.suruga-ya.jp/product/detail/120158641?tenpo_cd=201206&branch_number=9401';
  const a = await call('/api/join', 'POST', { url: L2, shopId: '201206', branch: '9401', cn: '甲', pin: '1111', cap: 0, qty: 1 });
  const b = await call('/api/join', 'POST', { url: L2, shopId: '201206', branch: '9401', cn: '乙', pin: '2222', cap: 0, qty: 1 });
  assert.equal(b.data.items.length, 1, '加入后只返回自己的物品');
  assert.equal(b.data.items[0].cn, '乙');
  assert.equal(b.data.result.members.length, 2, '但能看到谁在拼、件数和金额');
  assert.ok(!JSON.stringify(b.data.result).includes('tenpo_cd'), '公开数据里没有商品链接');

  const id = a.data.order.id;
  const anon = await call(`/api/orders/${id}`);
  assert.equal(anon.data.items.length, 0);
  const asA = await call(`/api/orders/${id}`, 'GET', null, { 'X-Member-Token': a.data.token });
  assert.deepEqual(asA.data.items.map((i) => i.cn), ['甲']);
  assert.equal(asA.data.me, '甲');

  const fake = await call(`/api/orders/${id}`, 'GET', null, { 'X-Member-Token': `${a.data.token.split('.')[0]}.0000` });
  assert.equal(fake.data.items.length, 0, '伪造凭证无效');

  // 乙不能撤销甲的物品
  const itemA = asA.data.items[0].id;
  let r = await call(`/api/items/${itemA}/remove`, 'POST', {}, { 'X-Member-Token': b.data.token });
  assert.equal(r.status, 403);
  r = await call(`/api/items/${itemA}/remove`, 'POST', {}, { 'X-Member-Token': a.data.token });
  assert.equal(r.status, 200);

  // 团长同时也是团员：两个身份都在时，能看到全部，也能撤销自己的
  const both = { 'X-Member-Token': b.data.token, 'X-Admin-Key': 'admin' };
  const asBoth = await call(`/api/orders/${id}`, 'GET', null, both);
  assert.equal(asBoth.data.me, '乙');
  assert.equal(asBoth.data.admin, true);
  r = await call(`/api/items/${b.data.items[0].id}/remove`, 'POST', {}, both);
  assert.equal(r.status, 200, '团长身份下也能撤销自己的物品');

  const login = await call('/api/login', 'POST', { cn: '乙', pin: '2222' });
  assert.equal(login.status, 200);
  assert.equal((await call('/api/login', 'POST', { cn: '乙', pin: '9999' })).status, 403);
});

test('团长后台：口令、改运费', async () => {
  let r = await call('/api/admin/group');
  assert.equal(r.status, 401);
  r = await call('/api/admin/shops/400486', 'PUT', { tiers: [{ min: 0, fee: 600 }, { min: 3000, fee: 0 }] }, { 'X-Admin-Key': 'admin' });
  assert.equal(r.status, 200);
  r = await call('/api/admin/members/reset-pin', 'POST', { cn: '阿柚', pin: '1130' }, { 'X-Admin-Key': 'admin' });
  assert.equal(r.status, 200);
  assert.equal((await call('/api/login', 'POST', { cn: '阿柚', pin: '1130' })).status, 200);
  r = await call('/api/admin/members/reset-pin', 'POST', { cn: '不存在', pin: '1130' }, { 'X-Admin-Key': 'admin' });
  assert.equal(r.status, 404);
  const s = await call(`/api/scrape?url=${encodeURIComponent(LINK)}`);
  assert.deepEqual(s.data.listings[0].tiers, [{ min: 0, fee: 600 }, { min: 3000, fee: 0 }]);
});

test('团长导出 Excel：一件一行，表头固定，带图片', async () => {
  const list = await call('/api/admin/orders', 'GET', null, { 'X-Admin-Key': 'admin' });
  assert.equal(list.status, 200);
  const done = list.data.orders.find((o) => o.order.status === 'ordered');
  assert.ok(done, '后台能看到已下单的团');
  assert.ok(done.items.every((i) => i.cn && i.title), '后台能看到谁买了什么');
  assert.equal((await call('/api/admin/orders')).status, 401);

  const res = await worker.fetch(new Request(`https://pin.example.com/api/admin/orders/${done.order.id}/export`, { headers: { 'X-Admin-Key': 'admin' } }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /spreadsheetml/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
  const text = new TextDecoder().decode(buf);
  for (const h of ['名称', '图片', '商品链接', '平时价格', '实际价格', 'cn']) assert.ok(text.includes(`<t xml:space="preserve">${h}</t>`), h);
  assert.ok(text.includes('xl/media/image1.png'), '嵌入了商品图');
  const sheet = text.slice(text.indexOf('<worksheet'), text.indexOf('</worksheet>'));
  const qty = done.items.reduce((a, i) => a + i.qty, 0);
  assert.equal((sheet.match(/<row /g) || []).length, qty + 1, '一件一行');

  const bad = await worker.fetch(new Request(`https://pin.example.com/api/admin/orders/${done.order.id}/export`), env);
  assert.equal(bad.status, 401);
});

test('店铺独自商品（ZHORE…）也能贴链接、加入', async () => {
  const Z = 'https://www.suruga-ya.jp/product/detail/ZHORE185731?tenpo_cd=200985';
  const s = await call(`/api/scrape?url=${encodeURIComponent(Z)}`);
  assert.equal(s.status, 200);
  assert.equal(s.data.listings.length, 1);
  const l = s.data.listings[0];
  assert.equal(l.shopId, '200985');
  assert.equal(l.price, 650);
  const r = await call('/api/join', 'POST', { url: l.url, shopId: l.shopId, branch: l.branch, cn: '阿柚', pin: '1130', cap: 500, qty: 1 });
  assert.equal(r.status, 200, r.data.error);
  assert.equal(r.data.items[0].price, 650);
  assert.equal(r.data.items[0].url, Z);
});

test('海外站链接：按日本站同一编号抓取在售店铺', async () => {
  const s = await call(`/api/scrape?url=${encodeURIComponent('https://www.suruga-ya.com/zh-hans/product/120158641')}`);
  assert.equal(s.status, 200, s.data.error);
  assert.equal(s.data.listings.length, 4);
  assert.match(s.data.listings[0].url, /^https:\/\/www\.suruga-ya\.jp\/product\/detail\/120158641\?/);
});
