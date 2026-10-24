import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, settle, shippingFee, freeThreshold } from '../public/calc.js';

const fixed400 = [{ min: 0, fee: 400 }];
const sanyodo = [{ min: 0, fee: 550 }, { min: 2000, fee: 0 }];

test('分档运费与包邮门槛', () => {
  assert.equal(shippingFee(sanyodo, 1999), 550);
  assert.equal(shippingFee(sanyodo, 2000), 0);
  assert.equal(freeThreshold(sanyodo), 2000);
  assert.equal(freeThreshold(fixed400), null);
});

test('运费按金额比例分摊，买得多的人分得多', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: '阿柚', price: 680, qty: 1 },
      { member: '小鹿', price: 1200, qty: 1 },
      { member: '糯米', price: 680, qty: 1 },
    ],
    caps: { 阿柚: 150, 小鹿: 100, 糯米: 150 },
  });
  assert.equal(r.subtotal, 2560);
  assert.deepEqual(r.members.map((m) => Math.round(m.share)), [106, 188, 106]);
  assert.deepEqual(r.members.map((m) => m.ok), [true, false, true]);
  // 小鹿要求 400×1200÷100 = 4800，差 2240
  assert.equal(r.success, false);
  assert.equal(r.via, 'split');
  assert.equal(r.target, 4800);
  assert.equal(r.needYen, 2240);
});

test('总金额够了全员达标就成团', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: '阿柚', price: 680, qty: 1 },
      { member: '小鹿', price: 1200, qty: 1 },
      { member: '糯米', price: 2920, qty: 1 },
    ],
    caps: { 阿柚: 150, 小鹿: 100, 糯米: 300 },
  });
  assert.equal(r.subtotal, 4800);
  assert.equal(r.success, true);
  assert.equal(r.reason, 'split');
  assert.equal(r.needYen, 0);
});

test('满额包邮店：差多少钱包邮', () => {
  const r = evaluate({
    tiers: sanyodo,
    items: [
      { member: '栗子', price: 600, qty: 1 },
      { member: '阿柚', price: 380, qty: 1 },
      { member: '七七', price: 400, qty: 1 },
    ],
    caps: { 栗子: 0, 阿柚: 0, 七七: 0 },
  });
  assert.equal(r.success, false);
  assert.equal(r.needYen, 620);
  assert.equal(r.via, 'free');
  assert.equal(r.needSplitYen, null); // 都只接受包邮
});

test('包邮和均摊两条路取更近的', () => {
  const r = evaluate({
    tiers: sanyodo,
    items: [{ member: 'A', price: 1000, qty: 1 }, { member: 'B', price: 500, qty: 1 }],
    caps: { A: 400, B: 200 },
  });
  // 包邮差 500；均摊：A 要 550×1000÷400=1375，B 要 550×500÷200=1375 → 已满足？ 1500 ≥ 1375，A 分 367 ≤ 400，B 分 183 ≤ 200
  assert.equal(r.success, true);
  assert.equal(r.reason, 'split');
});

test('达到门槛即包邮成团', () => {
  const r = evaluate({ tiers: sanyodo, items: [{ member: 'A', price: 2030, qty: 1 }], caps: { A: 0 } });
  assert.equal(r.success, true);
  assert.equal(r.reason, 'free');
  assert.equal(r.fee, 0);
});

test('结算：每人应付 = 商品 + 按金额分摊的运费', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: '小鹿', price: 1000, qty: 2 },
      { member: '栗子', price: 1000, qty: 1 },
      { member: '阿柚', price: 1000, qty: 1 },
    ],
    caps: { 小鹿: 200, 栗子: 100, 阿柚: 100 },
  });
  assert.equal(r.success, true);
  const s = settle(r);
  assert.deepEqual(s.rows.map((x) => x.shipping), [200, 100, 100]);
  assert.equal(s.sum, 4400);
  assert.equal(s.rounding, 0);
});

test('空团', () => {
  const r = evaluate({ tiers: fixed400, items: [], caps: {} });
  assert.equal(r.success, false);
  assert.equal(r.count, 0);
});
