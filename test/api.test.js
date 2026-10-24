// 用 Node 自带的 SQLite 模拟 D1，把加入 → 撤销 → 成团发邮件整条流程跑一遍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/product/other/')) return new Response(fx('other.html'));
  if (u.includes('/shop/delivery/')) return new Response(fx('delivery-fixed.html'));
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
  assert.equal(r.data.result.needItems, 2);

  r = await call(`/api/items/${itemId}/remove`, 'POST', { pin: '0000' });
  assert.equal(r.status, 403, '错误 PIN 不能撤销');
  r = await call(`/api/items/${itemId}/remove`, 'POST', { pin: '5678' });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.count, 1);

  await join('小鹿', '5678', 100);
  await join('糯米', '2468', 150);
  assert.equal(sent.length, 0);
  r = await join('七七', '1357', 100);
  assert.equal(r.data.order.status, 'done');
  assert.equal(r.data.mailStatus, 'sent');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['buyer@example.com']);
  assert.match(sent[0].html, /tenpo_cd=400486/);

  const list = await call('/api/orders');
  assert.equal(list.data.orders.length, 1);
  assert.equal(list.data.orders[0].order.status, 'done');

  // 成团后不能自己撤销
  const any = list.data.orders[0].items[0].id;
  r = await call(`/api/items/${any}/remove`, 'POST', { pin: '1234' });
  assert.equal(r.status, 409);
});

test('团长后台：口令、改运费', async () => {
  let r = await call('/api/admin/group');
  assert.equal(r.status, 401);
  r = await call('/api/admin/shops/400486', 'PUT', { tiers: [{ min: 0, fee: 600 }, { min: 3000, fee: 0 }] }, { 'X-Admin-Key': 'admin' });
  assert.equal(r.status, 200);
  const s = await call(`/api/scrape?url=${encodeURIComponent(LINK)}`);
  assert.deepEqual(s.data.listings[0].tiers, [{ min: 0, fee: 600 }, { min: 3000, fee: 0 }]);
});
