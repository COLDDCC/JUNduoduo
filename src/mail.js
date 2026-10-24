// 成团邮件：用 Resend 发给代购
import { settle } from './calc.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const jpy = (n) => `¥${Math.round(n).toLocaleString('ja-JP')}`;

export function buildMail({ order, items, result, siteUrl }) {
  const s = settle(result);
  const subject = `【骏和屋拼单成团】${order.shop_name} · ${result.count} 件 · 运费 ${jpy(result.fee)}`;

  const itemRows = items
    .map(
      (i) =>
        `<tr><td>${esc(i.cn)}</td><td><a href="${esc(i.url)}">${esc(i.title || i.url)}</a></td><td align="right">${jpy(i.price)}</td><td align="center">${i.qty}</td></tr>`,
    )
    .join('');
  const payRows = s.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.member)}</td><td align="center">${r.qty}</td><td align="right">${jpy(r.goods)}</td><td align="right">${jpy(r.shipping)}</td><td align="right"><b>${jpy(r.total)}</b></td></tr>`,
    )
    .join('');

  const html = `
<div style="font-family:sans-serif;font-size:14px;color:#1f1a17">
<h2 style="margin:0 0 8px">${esc(order.shop_name)} 已成团，请下单</h2>
<p>${result.reason === 'free' ? '已达包邮门槛，运费 ¥0。' : `运费 ${jpy(result.fee)}，按件均摊，每件 ${jpy(result.perItem)}。`}</p>
<h3>下单商品（共 ${result.count} 件，合计 ${jpy(result.subtotal)}）</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr><th>CN</th><th>商品链接</th><th>单价</th><th>数量</th></tr>${itemRows}</table>
<h3>每人应付</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
<tr><th>CN</th><th>件数</th><th>商品</th><th>运费</th><th>合计</th></tr>${payRows}
<tr><td colspan="4" align="right">总计</td><td align="right"><b>${jpy(s.sum)}</b></td></tr></table>
${s.rounding ? `<p style="color:#6b625c">四舍五入差额 ${jpy(s.rounding)}</p>` : ''}
${siteUrl ? `<p><a href="${esc(siteUrl)}/#/order/${esc(order.id)}">在拼单页查看</a></p>` : ''}
</div>`;

  const text = [
    `${order.shop_name} 已成团`,
    ...items.map((i) => `${i.cn}  ${i.url}  ${jpy(i.price)} × ${i.qty}`),
    '',
    ...s.rows.map((r) => `${r.member}: 商品 ${jpy(r.goods)} + 运费 ${jpy(r.shipping)} = ${jpy(r.total)}`),
    `总计 ${jpy(s.sum)}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendMail(env, { to, cc, subject, html, text }) {
  if (!env.RESEND_API_KEY) return 'failed:未配置 RESEND_API_KEY';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'onboarding@resend.dev',
      to: [to],
      cc: cc ? [cc] : undefined,
      subject,
      html,
      text,
    }),
  });
  if (res.ok) return 'sent';
  return `failed:${res.status} ${(await res.text()).slice(0, 200)}`;
}
