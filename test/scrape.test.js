import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseProductId,
  parseListingHint,
  parseOtherPage,
  parseDetailSale,
  parseSingleShopDetail,
  parseSinglePage,
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
  assert.equal(r.title, '進撃の巨人 The Final Season Original Sound Track Complete Album[Blu-ray付]');
  assert.equal(r.image, 'https://www.suruga-ya.jp/database/photo.php?shinaban=120158641&size=m');
  assert.equal(r.listings[1].shopName, 'ブックマーケットエーツー豊川店');
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

test('src/schema.js 与 schema.sql 一致', async () => {
  const { default: js } = await import('../src/schema.js');
  assert.equal(js, readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
});

test('只有“全国一律”一行的配送页', () => {
  const r = parseDeliveryPage(fx('delivery-flat.html'), '大阪府');
  assert.deepEqual(r.tiers, [{ min: 0, fee: 614 }]);
});

test('店铺独自商品：只有一条出品、没有 branch_number 的商品页', () => {
  const r = parseSinglePage(fx('single.html'), 'ZHORE185731', { shopId: '200985', branch: null });
  assert.equal(r.title, '男性向一般同人誌 Honey Trap / saku / シガーレス。');
  assert.equal(r.listings.length, 1);
  const l = r.listings[0];
  assert.equal(l.shopId, '200985');
  assert.equal(l.shopName, 'ブックマーケット函館美原店 Supported by 駿河屋');
  assert.equal(l.price, 650, '取售价，不取定价');
  assert.equal(l.condition, '中古');
  assert.equal(l.url, 'https://www.suruga-ya.jp/product/detail/ZHORE185731?tenpo_cd=200985');
  assert.equal(parseProductId('https://www.suruga-ya.jp/product/detail/ZHORE185731?tenpo_cd=200985'), 'ZHORE185731');
  assert.equal(parseOtherPage(fx('single.html'), 'ZHORE185731').listings.length, 0);
  // 售完（没有在庫数）→ 无售价
  const sold = parseSinglePage(fx('single.html').replace('在庫数：1', '品切れ'), 'ZHORE185731');
  assert.equal(sold.listings[0].price, null);
});

test('店铺链接只有 tenpo_cd、没有 branch_number 时仍可解析', () => {
  const html = `<html><title>Honey Trap / saku / シガーレス。</title>
  <div>中古 650円</div>
  <a href="/product/detail/ZHORE185731?tenpo_cd=200985">中古</a>
  <a href="/shop/200985">ブックマーケット函館美原店</a></html>`;
  const r = parseOtherPage(html, 'ZHORE185731');
  assert.equal(r.listings.length, 1);
  assert.equal(r.listings[0].shopId, '200985');
  assert.equal(r.listings[0].branch, '-', '没有 branch_number 用占位，否则加入时会被拒');
  assert.equal(r.listings[0].price, 650);
  assert.equal(r.listings[0].url, 'https://www.suruga-ya.jp/product/detail/ZHORE185731?tenpo_cd=200985');
});

test('唯一店铺详情页没有出品链接时恢复商品价格与店铺', () => {
  const html = `<h1>Honey Trap</h1>
    <a href="/product/detail/ZHORE185731?tenpo_cd=200985">商品</a>
    <p>中古 650円 (税込) 在庫数：1</p>
    <a href="/shop/200985">ブックマーケット函館美原店</a>`;
  const r = parseSingleShopDetail(html, 'ZHORE185731');
  assert.equal(r.shopId, '200985');
  assert.equal(r.price, 650);
  assert.equal(r.url, 'https://www.suruga-ya.jp/product/detail/ZHORE185731?tenpo_cd=200985');
  assert.equal(parseSingleShopDetail(html + '申し訳ございません。品切れ中です。', 'ZHORE185731'), null);
});

test('商品详情 HTML 标签隔开价格和库存时仍识别 650 日元', () => {
  const html = '<div>中古 <strong>650円</strong> (税込) ' + '<span class="space"></span>'.repeat(1200) + '<span>在庫数：1</span></div>';
  assert.deepEqual(parseDetailSale(html), { price: 650, condition: '中古' });
  assert.deepEqual(parseDetailSale('<p>中古 650円 (税込) 在庫数：0</p>'), { price: null, condition: null });
});

test('海外站链接也能认出商品编号', () => {
  assert.equal(parseProductId('https://www.suruga-ya.com/zh-hans/product/646231689'), '646231689');
  assert.equal(parseProductId('https://www.suruga-ya.com/en/product/646231689?foo=1'), '646231689');
  assert.equal(parseProductId('https://www.suruga-ya.com/product/646231689'), '646231689');
  assert.equal(parseProductId('https://www.suruga-ya.com/zh-hant/product/ZHORE185731'), 'ZHORE185731');
  assert.equal(parseProductId('https://www.suruga-ya.com/zh-hans/search?keyword=x'), null);
});
