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

test('名古屋乙女館：3 件时小鹿超上限，还差 1 件', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: '阿柚', price: 680, qty: 1 },
      { member: '小鹿', price: 1200, qty: 1 },
      { member: '糯米', price: 680, qty: 1 },
    ],
    caps: { 阿柚: 150, 小鹿: 100, 糯米: 150 },
  });
  assert.equal(r.success, false);
  assert.equal(r.needItems, 1);
  assert.equal(r.needYen, null);
  assert.equal(Math.round(r.perItem), 133);
  assert.deepEqual(r.members.map((m) => m.ok), [true, false, true]);
});

test('第 4 件加入后全员达标成团', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: '阿柚', price: 680, qty: 1 },
      { member: '小鹿', price: 1200, qty: 1 },
      { member: '糯米', price: 680, qty: 2 },
    ],
    caps: { 阿柚: 150, 小鹿: 100, 糯米: 200 },
  });
  assert.equal(r.success, true);
  assert.equal(r.reason, 'split');
  assert.equal(r.needItems, 0);
});

test('买 2 件的人分到两份运费', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: 'A', price: 500, qty: 2 },
      { member: 'B', price: 500, qty: 2 },
    ],
    caps: { A: 150, B: 300 },
  });
  // 每人 200，A 超上限；A 需要 N ≥ 400×2/150 → 6
  assert.equal(r.success, false);
  assert.equal(r.needItems, 2);
});

test('满额包邮店：差多少钱', () => {
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
  assert.equal(r.needItems, null); // 都只接受包邮
});

test('达到门槛即包邮成团', () => {
  const r = evaluate({
    tiers: sanyodo,
    items: [{ member: 'A', price: 2030, qty: 1 }],
    caps: { A: 0 },
  });
  assert.equal(r.success, true);
  assert.equal(r.reason, 'free');
  assert.equal(r.fee, 0);
});

test('结算：池袋乙女館 5 件每件 80', () => {
  const r = evaluate({
    tiers: fixed400,
    items: [
      { member: '小鹿', price: 450, qty: 2 },
      { member: '栗子', price: 1500, qty: 1 },
      { member: '阿柚', price: 780, qty: 1 },
      { member: '七七', price: 320, qty: 1 },
    ],
    caps: { 小鹿: 200, 栗子: 100, 阿柚: 100, 七七: 100 },
  });
  assert.equal(r.success, true);
  const s = settle(r);
  assert.deepEqual(s.rows.map((x) => x.total), [1060, 1580, 860, 400]);
  assert.equal(s.sum, 3900);
  assert.equal(s.rounding, 0);
});

test('空团', () => {
  const r = evaluate({ tiers: fixed400, items: [], caps: {} });
  assert.equal(r.success, false);
  assert.equal(r.count, 0);
});
