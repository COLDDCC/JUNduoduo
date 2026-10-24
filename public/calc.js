// 成团判定与“还差多少”的计算。纯函数，方便测试。

/** 按分档规则算运费：取 min ≤ 合计金额 的最后一档 */
export function shippingFee(tiers, subtotal) {
  if (!tiers || !tiers.length) return null;
  let fee = tiers[0].fee;
  for (const t of tiers) if (subtotal >= t.min) fee = t.fee;
  return fee;
}

/** 包邮门槛：第一个运费为 0 的档位金额；没有则 null */
export function freeThreshold(tiers) {
  const t = (tiers || []).find((x) => x.fee === 0 && x.min > 0);
  return t ? t.min : null;
}

/**
 * items: [{ member, price, qty }]（只传未撤销的）
 * caps:  { [member]: 该成员愿意分摊的运费上限（整单合计，日元） }
 * tiers: 店铺分档运费
 * 运费按金额比例分摊：分摊_i = 运费 × 商品金额_i ÷ 全团商品金额
 */
export function evaluate({ items, caps, tiers }) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const count = items.reduce((s, i) => s + i.qty, 0);
  const threshold = freeThreshold(tiers);
  const fee = shippingFee(tiers, subtotal) ?? 0;
  const baseFee = shippingFee(tiers, 0) ?? 0; // 不包邮时的运费，用来算“还差多少”

  const byMember = new Map();
  for (const i of items) {
    const m = byMember.get(i.member) || { member: i.member, qty: 0, goods: 0 };
    m.qty += i.qty;
    m.goods += i.price * i.qty;
    byMember.set(i.member, m);
  }

  const members = [...byMember.values()].map((m) => {
    const share = subtotal ? (fee * m.goods) / subtotal : 0;
    const cap = caps[m.member] ?? 0;
    return { ...m, cap, share, ok: share <= cap + 1e-9 };
  });

  const freeShip = fee === 0 && count > 0;
  const allOk = count > 0 && members.every((m) => m.ok);
  const success = freeShip || allOk;

  // 均摊全员达标所需的最低总金额 G* = max(运费 × 金额_i ÷ 上限_i)
  let splitTarget = subtotal;
  for (const m of members) {
    const need = m.cap > 0 ? Math.ceil((baseFee * m.goods) / m.cap - 1e-9) : Infinity;
    splitTarget = Math.max(splitTarget, need);
  }
  const needSplitYen = success ? 0 : Number.isFinite(splitTarget) ? splitTarget - subtotal : null;
  const needFreeYen = threshold != null ? Math.max(0, threshold - subtotal) : null;
  // 两条路取更近的那条
  const options = [needFreeYen, needSplitYen].filter((x) => x != null);
  const needYen = success ? 0 : options.length ? Math.min(...options) : null;
  const via = needYen == null || success ? null : needYen === needFreeYen ? 'free' : 'split';
  const target = via === 'free' ? threshold : via === 'split' ? splitTarget : subtotal;

  return {
    subtotal,
    count,
    fee,
    threshold,
    rate: subtotal ? fee / subtotal : 0, // 每 1 日元商品分摊多少运费
    members,
    success,
    reason: freeShip ? 'free' : allOk ? 'split' : null,
    needYen, // 还差多少日元成团；null = 有人只接受包邮且这家店没有包邮门槛
    needFreeYen, // 离包邮还差多少；null = 没有包邮门槛
    needSplitYen, // 离均摊全员达标还差多少
    via, // 'free' 走包邮 / 'split' 走均摊
    target, // 成团目标金额
  };
}

/** 结算：每人应付（商品 + 运费分摊，四舍五入到日元） */
export function settle(result) {
  const rows = result.members.map((m) => ({
    member: m.member,
    qty: m.qty,
    goods: m.goods,
    shipping: Math.round(m.share),
    total: m.goods + Math.round(m.share),
  }));
  const sum = rows.reduce((s, r) => s + r.total, 0);
  return { rows, sum, rounding: sum - (result.subtotal + result.fee) };
}
