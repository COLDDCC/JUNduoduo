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
 */
export function evaluate({ items, caps, tiers }) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const count = items.reduce((s, i) => s + i.qty, 0);
  const threshold = freeThreshold(tiers);
  const fee = shippingFee(tiers, subtotal) ?? 0;
  const baseFee = shippingFee(tiers, 0) ?? 0; // 不包邮时的运费，用来算“还差几件”

  const byMember = new Map();
  for (const i of items) {
    const m = byMember.get(i.member) || { member: i.member, qty: 0, goods: 0 };
    m.qty += i.qty;
    m.goods += i.price * i.qty;
    byMember.set(i.member, m);
  }

  const members = [...byMember.values()].map((m) => {
    const share = count ? (fee * m.qty) / count : 0;
    const cap = caps[m.member] ?? 0;
    return { ...m, cap, share, ok: share <= cap + 1e-9 };
  });

  const freeShip = fee === 0 && count > 0;
  const allOk = count > 0 && members.every((m) => m.ok);
  const success = freeShip || allOk;

  // 均摊全员达标所需的最少件数 N* = max ceil(S × n_i / cap_i)
  let targetCount = count;
  for (const m of members) {
    const need = m.cap > 0 ? Math.ceil((baseFee * m.qty) / m.cap - 1e-9) : Infinity;
    targetCount = Math.max(targetCount, need);
  }
  const needItems = success ? 0 : Number.isFinite(targetCount) ? targetCount - count : null;
  const needYen = threshold != null ? Math.max(0, threshold - subtotal) : null;

  return {
    subtotal,
    count,
    fee,
    threshold,
    perItem: count ? fee / count : fee,
    members,
    success,
    reason: freeShip ? 'free' : allOk ? 'split' : null,
    needItems, // null = 有人只接受包邮，件数再多也不行
    needYen, // null = 这家店没有包邮门槛
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
