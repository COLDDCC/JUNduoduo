import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseProductId,
  parseListingHint,
  parseOtherPage,
  parseDeliveryPage,
  HONTEN_ID,
} from '../src/scrape.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('两种链接都能取到同一个商品编号', () => {
  assert.equal(parseProductId('https://www.suruga-ya.jp/product/other/120158641'), '120158641');
  assert.equal(parseProductId('https://www.suruga-ya.jp/product/detail/120158641?branch_number=0071'), '120158641');
  assert.equal(parseProductId('https://example.com/product/other/1'), null);
});

test('链接里的出品信息', () => {
  assert.deepEqual(parseListingHint('https://www.suruga-ya.jp/product/detail/120158641?branch_number=0071'), {
    shopId: HONTEN_ID,
    branch: '0071',
  });
  assert.deepEqual(
    parseListingHint('https://www.suruga-ya.jp/product/detail/120158641?tenpo_cd=400486&branch_number=0001'),
    { shopId: '400486', branch: '0001' },
  );
  assert.deepEqual(parseListingHint('https://www.suruga-ya.jp/product/other/120158641'), { shopId: null, branch: null });
});

test('解析在售店铺列表（去重、本店、按价格排序）', () => {
  const r = parseOtherPage(fx('other.html'), '120158641');
  assert.match(r.title, /進撃の巨人/);
  assert.equal(r.image, 'https://www.suruga-ya.jp/database/pics_light/game/120158641.jpg');
  assert.equal(r.listings.length, 4);
  assert.deepEqual(
    r.listings.map((l) => [l.shopId, l.branch, l.price]),
    [
      ['400486', '0001', 4850],
      ['201206', '9401', 4888],
      [HONTEN_ID, '0001', 5800],
      [HONTEN_ID, '0071', 8400],
    ],
  );
  assert.equal(r.listings[0].shopName, '駿河屋高松瓦町FLAG店');
  assert.equal(
    r.listings[0].url,
    'https://www.suruga-ya.jp/product/detail/120158641?tenpo_cd=400486&branch_number=0001',
  );
});

test('固定运费的配送页', () => {
  const r = parseDeliveryPage(fx('delivery-fixed.html'), '大阪府');
  assert.equal(r.shopName, '駿河屋名古屋乙女館');
  assert.deepEqual(r.tiers, [{ min: 0, fee: 400 }]);
});

test('满额包邮的配送页', () => {
  const r = parseDeliveryPage(fx('delivery-tiered.html'), '大阪府');
  assert.deepEqual(r.tiers, [
    { min: 0, fee: 550 },
    { min: 2000, fee: 0 },
  ]);
});
