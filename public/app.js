import { evaluate, freeThreshold, settle } from './calc.js';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

// ---------- 小工具 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jpy = (n) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const AV_COLORS = ['#F3D7C9', '#D9E4EF', '#E3DCF0', '#DCEBDD', '#FCE3B8', '#F5D0DC', '#D6ECEC'];
const avColor = (s) => AV_COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];
const av = (cn, cls = '') => `<span class="av ${cls}" style="background:${avColor(cn)}">${esc([...cn][0] || '?')}</span>`;
const thumb = (src, cls = '') =>
  `<span class="thumb ${cls}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
const searchIcon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const backIcon =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';

function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function describeTiers(tiers) {
  if (!tiers || !tiers.length) return '运费未知，等团长设置';
  const T = freeThreshold(tiers);
  if (tiers.length === 1) return tiers[0].fee === 0 ? '包邮' : `固定运费 ${jpy(tiers[0].fee)} · 均摊型`;
  if (T != null) return `满 ${jpy(T)} 包邮 · 不满运费 ${jpy(tiers[0].fee)}`;
  return tiers.map((t) => `${jpy(t.min)}起 ${jpy(t.fee)}`).join(' / ');
}

/** 统一的进度描述，首页卡片、选店、详情页共用 */
function progressView(r, tiers) {
  const memberCount = r.members.length;
  if (r.success) {
    return { tag: '可成团', ok: true, pct: 100, left: `${memberCount} 人 · ${r.count} 件`, right: r.reason === 'free' ? '已包邮' : `每件 ${jpy(r.perItem)}`, hint: '' };
  }
  if (r.threshold != null && r.needYen != null) {
    const splitHint =
      r.needItems != null && r.needItems > 0 ? `；或再来 ${r.needItems} 件，均摊也能全员达标` : '';
    return {
      tag: `差 ${jpy(r.needYen)}`,
      pct: Math.min(100, (r.subtotal / r.threshold) * 100),
      left: `${memberCount} 人 · ${r.count} 件 · 已拼 <b>${jpy(r.subtotal)}</b>`,
      right: `包邮线 ${jpy(r.threshold)}`,
      hint: `再拼 ${jpy(r.needYen)} 就包邮${splitHint}`,
      empty: 0,
    };
  }
  if (r.needItems == null) {
    return { tag: '需包邮', pct: 0, left: `${memberCount} 人 · ${r.count} 件`, right: '', hint: '有人只接受包邮，这家店没有包邮门槛，请团长处理', empty: 0 };
  }
  const target = r.count + r.needItems;
  const fee0 = tiers?.[0]?.fee ?? r.fee;
  return {
    tag: `还差 ${r.needItems} 件`,
    pct: target ? (r.count / target) * 100 : 0,
    left: `${memberCount} 人 · ${r.count} 件 · 每件均摊 <b>${jpy(r.perItem)}</b>`,
    right: `目标 ${target} 件`,
    hint: `再来 ${r.needItems} 件 → 每件 ${jpy(fee0 / target)}，所有人都在自己的上限内，自动成团`,
    empty: Math.min(r.needItems, 4),
  };
}

// ---------- 路由 ----------
let timer = null;
function route() {
  clearInterval(timer);
  $sheet.hidden = true;
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  window.scrollTo(0, 0);
  if (path === '/' || path === '') return home();
  if (path === '/pick') return pick(params.get('url'));
  if (path.startsWith('/order/')) return order(path.slice(7));
  if (path === '/admin') return admin();
  home();
}
window.addEventListener('hashchange', route);

// ---------- 首页 ----------
async function home() {
  $app.innerHTML = `
  <header class="topbar">
    <div class="topbar-row"><span class="brand">骏和屋拼单</span><span class="muted" id="pref">发往大阪</span></div>
    <form class="search" id="go" role="search">
      ${searchIcon}
      <input id="link" type="url" inputmode="url" placeholder="粘贴骏和屋商品链接" aria-label="粘贴骏和屋商品链接" required>
      <button>开拼</button>
    </form>
  </header>
  <main id="list"><p class="loading">读取中…</p></main>`;
  const $link = document.getElementById('link');
  document.getElementById('go').onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/pick?url=${encodeURIComponent($link.value.trim())}`;
  };
  // 粘贴后直接跳转，省一次点击
  $link.addEventListener('paste', () => setTimeout(() => {
    if (/suruga-ya\.jp\/product\//.test($link.value)) document.getElementById('go').requestSubmit();
  }, 0));
  const load = async () => {
    try {
      const d = await api('/api/orders');
      document.getElementById('pref').textContent = `发往${d.prefecture.replace(/[府県都]$/, '')}`;
      renderHome(d.orders);
    } catch (e) {
      document.getElementById('list').innerHTML = `<p class="empty-state">${esc(e.message)}</p>`;
    }
  };
  await load();
  timer = setInterval(load, 10000);
}

function renderHome(orders) {
  const open = orders.filter((o) => o.order.status === 'open');
  const done = orders.filter((o) => o.order.status === 'done');
  const $list = document.getElementById('list');
  if (!$list) return;
  $list.innerHTML = `
    <div class="sec-title"><h2>正在拼的分店 · ${open.length}</h2></div>
    ${open.length ? open.map(shopCard).join('') : '<p class="empty-state">还没有人开团，在上面粘贴链接开第一个吧。</p>'}
    ${done.length ? `<div class="sec-title" style="margin-top:8px"><h2 style="font-size:15px;color:var(--quiet)">已成团</h2></div>` : ''}
    ${done
      .map(
        (o) => `<a class="done-link" href="#/order/${o.order.id}">
          <div style="display:flex;flex-direction:column;gap:3px"><b>${esc(o.order.shop_name)}</b>
          <span class="muted">${o.result.members.length} 人 · ${o.result.count} 件${o.order.mail_status === 'sent' ? '' : ' · 邮件未发出'}</span></div>
          <span class="tag ok">已成团</span></a>`,
      )
      .join('')}`;
}

function whoLine(r) {
  return r.members.map((m) => `${esc(m.member)} ${m.qty}件 ${jpy(m.goods)}`).join('、');
}

function shopCard(d) {
  const r = d.result;
  const v = progressView(r, d.tiers);
  const imgs = [...new Map(d.items.map((i) => [i.product_id, i.image])).values()];
  return `<a class="card link shop" href="#/order/${d.order.id}">
    <div class="shop-img">${thumb(imgs[0], 'lg')}${imgs.length > 1 ? `<span class="more">+${imgs.length - 1}</span>` : ''}</div>
    <div class="shop-body">
      <div class="card-head"><h3>${esc(d.order.shop_name)}</h3><span class="tag ${v.ok ? 'ok' : ''}">${v.tag}</span></div>
      <div class="bar sm"><i style="width:${v.pct}%"></i></div>
      <div class="who">${whoLine(r)}</div>
      <div class="meta"><span>合计 ${r.count} 件 · ${jpy(r.subtotal)}</span><span class="muted">${r.fee ? `每件运费 ${jpy(r.perItem)}` : '包邮'}</span></div>
    </div></a>`;
}

// ---------- 贴链接 → 选分店 ----------
async function pick(url) {
  $app.innerHTML = `
  <header class="hero" style="background:#fff;color:var(--ink);padding:10px 16px;border-bottom:1px solid #EDE6E0">
    <div class="titlebar"><a class="back" href="#/" aria-label="返回">${backIcon}</a><h1>选一家店加入</h1></div>
  </header>
  <main style="margin-top:0"><p class="loading">正在读取骏和屋，第一次可能要几秒…</p></main>`;
  const $main = $app.querySelector('main');
  let data;
  try {
    data = await api(`/api/scrape?url=${encodeURIComponent(url || '')}`);
  } catch (e) {
    $main.innerHTML = `<p class="empty-state">${esc(e.message)}</p><a class="btn block" href="#/">返回重新贴</a>`;
    return;
  }
  const L = data.listings.filter((l) => l.price != null);
  if (!L.length) {
    $main.innerHTML = '<p class="empty-state">这件商品现在没有店铺在卖。</p><a class="btn block" href="#/">返回</a>';
    return;
  }
  const hint = data.hint || {};
  let sel = L.findIndex((l) => l.shopId === hint.shopId && l.branch === hint.branch);
  if (sel < 0) sel = 0;
  const me = { cn: store.get('cn') || '', qty: 1, cap: Number(store.get('cap') || 150) };

  const render = () => {
    $main.innerHTML = `
    <div class="product">${thumb(data.image, 'lg')}<div class="product-title">${esc(data.title || '骏和屋商品')}</div></div>
    ${L.map((l, i) => optCard(l, i === sel, me, i)).join('')}
    <form class="form" id="join">
      <div class="grid2">
        <div class="field"><label for="cn">你的 CN</label><input id="cn" maxlength="20" required value="${esc(me.cn)}"></div>
        <div class="field"><label for="pin">QQ 号后 4 位</label><input id="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required style="letter-spacing:6px"></div>
      </div>
      <div class="field"><label for="cap">最多愿意分摊的运费（日元）</label><input id="cap" type="number" inputmode="numeric" min="0" step="10" value="${me.cap}"></div>
      <div class="qty"><span style="width:auto;font-weight:400;font-size:13px;color:var(--ink-2)">数量</span>
        <div><button type="button" id="minus" aria-label="减少">−</button><span id="q">${me.qty}</span><button type="button" id="plus" aria-label="增加">+</button></div></div>
      <button class="btn block" id="submit">加入拼单</button>
    </form>`;
    $main.querySelectorAll('.opt').forEach((el) => (el.onclick = () => { sel = Number(el.dataset.i); keep(); render(); }));
    const keep = () => {
      me.cn = document.getElementById('cn').value.trim();
      me.cap = Number(document.getElementById('cap').value) || 0;
    };
    document.getElementById('cap').onchange = () => { keep(); render(); };
    document.getElementById('minus').onclick = () => { keep(); me.qty = Math.max(1, me.qty - 1); render(); };
    document.getElementById('plus').onclick = () => { keep(); me.qty = Math.min(20, me.qty + 1); render(); };
    document.getElementById('join').onsubmit = async (e) => {
      e.preventDefault();
      keep();
      const pin = document.getElementById('pin').value.trim();
      const btn = document.getElementById('submit');
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        const l = L[sel];
        const res = await api('/api/join', {
          method: 'POST',
          body: { url: l.url, shopId: l.shopId, branch: l.branch, cn: me.cn, pin, qty: me.qty, cap: me.cap },
        });
        store.set('cn', me.cn);
        store.set('cap', String(me.cap));
        toast(res.order.status === 'done' ? '已成团！邮件已发给代购' : '加入成功');
        location.hash = `#/order/${res.order.id}`;
      } catch (err) {
        toast(err.message, 4000);
        btn.disabled = false;
        btn.textContent = '加入拼单';
      }
    };
  };
  render();
}

function optCard(l, selected, me, idx) {
  const tiers = l.tiers;
  const p = l.progress;
  // 预览：把“我”加进去，重新算一次
  const items = (p?.members || []).map((m) => ({ member: m.member, price: m.goods / m.qty, qty: m.qty }));
  const caps = Object.fromEntries((p?.members || []).map((m) => [m.member, m.cap]));
  const self = me.cn || '我';
  items.push({ member: self, price: l.price, qty: me.qty });
  caps[self] = me.cap;
  const after = tiers ? evaluate({ items, caps, tiers }) : null;
  let preview = '运费未读到，加入后由团长确认';
  if (after) {
    if (after.success) preview = after.reason === 'free' ? `你加入后：${jpy(after.subtotal)} · 直接包邮成团` : `你加入后：每件 ${jpy(after.perItem)} · 全员达标，直接成团`;
    else if (after.needYen != null) preview = `你加入后：已拼 ${jpy(after.subtotal)} · 还差 ${jpy(after.needYen)} 包邮`;
    else if (after.needItems != null) preview = `你加入后：${after.count} 件，每件均摊 ${jpy(after.perItem)} · 还差 ${after.needItems} 件全员达标`;
    else preview = '你填的上限为 0，这家店没有包邮门槛，成不了团';
  }
  const people = p ? `${p.members.length} 人在拼 · ` : '';
  return `<div class="opt ${selected ? 'sel' : ''}" data-i="${idx}">
    <div class="opt-head"><label><input type="radio" name="shop" ${selected ? 'checked' : ''}>${esc(l.shopName)}</label><span class="price">${jpy(l.price)}</span></div>
    <span class="preview">${people}${describeTiers(tiers)}</span>
    ${selected ? `<span class="preview strong">${preview.replace('你加入后：', '加入后 ')}</span>` : ''}</div>`;
}

// ---------- 拼单详情 / 撤销 / 成团分账 ----------
async function order(id) {
  $app.innerHTML = '<p class="loading">读取中…</p>';
  const load = async () => {
    try {
      const d = await api(`/api/orders/${id}`);
      if (!$sheet.hidden) return; // 正在输 PIN 时不刷新
      d.order.status === 'open' ? renderOpen(d) : renderDone(d);
      if (d.order.status !== 'open') clearInterval(timer);
    } catch (e) {
      $app.innerHTML = `<p class="empty-state">${esc(e.message)}</p><main><a class="btn block" href="#/">回首页</a></main>`;
    }
  };
  await load();
  timer = setInterval(load, 10000);
}

function renderOpen(d) {
  const r = d.result;
  const v = progressView(r, d.tiers);
  const target = r.needItems != null && r.threshold == null ? r.count + r.needItems : null;
  const segN = target && target <= 12 ? target : 0;
  const headline = r.success
    ? '<span>条件已满足，正在成团…</span>'
    : r.threshold != null
      ? `<span>还差</span><b>${jpy(r.needYen).slice(1)}</b><span>日元包邮</span>`
      : r.needItems != null
        ? `<span>还差</span><b>${r.needItems}</b><span>件成团</span>`
        : '<span>需要团长处理</span>';
  const mine = store.get('cn');
  $app.innerHTML = `
  <header class="hero">
    <div class="titlebar"><a class="back" href="#/" aria-label="返回">${backIcon}</a><h1>${esc(d.order.shop_name)}</h1></div>
    <div class="big">${headline}</div>
    ${segN ? `<div class="segs" style="grid-template-columns:repeat(${segN},minmax(0,1fr))">${Array.from({ length: segN }, (_, i) => `<i class="${i < r.count ? 'on' : ''}"></i>`).join('')}</div>` : `<div class="bar" style="background:rgba(255,255,255,.32)"><i style="width:${v.pct}%;background:#fff"></i></div>`}
    <div class="hero-meta"><span>${r.members.length} 人 · ${r.count} 件 · ${jpy(r.subtotal)}</span><span>${describeTiers(d.tiers)}</span></div>
  </header>
  <main>
    <section class="list">
      ${r.members
        .map(
          (m) => `<div class="li"><div class="mid"><b>${esc(m.member)}${m.member === mine ? '（我）' : ''}</b></div>
          <div class="end"><b>运费 ${jpy(m.share)}</b>${m.ok ? `<span class="good">上限 ${jpy(m.cap)} 达标</span>` : `<span class="bad">超出上限 ${jpy(m.cap)}</span>`}</div></div>
          ${d.items
            .filter((i) => i.cn === m.member)
            .map((i) => `<div class="sub">${thumb(i.image)}<a href="${esc(i.url)}" target="_blank" rel="noopener" class="sub-t">${esc(i.title || '商品')}<br><b>${jpy(i.price)} × ${i.qty}</b></a><button class="mini" data-rm="${i.id}" data-cn="${esc(i.cn)}">撤销</button></div>`)
            .join('')}`,
        )
        .join('')}
    </section>
    <button class="btn block" id="share">复制链接发到群里</button>
  </main>`;
  $app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => askRemove(b.dataset.rm, b.dataset.cn, d)));
  document.getElementById('share').onclick = () => {
    const txt = `【骏和屋拼单】${d.order.shop_name}：${r.members.length} 人 ${r.count} 件，${v.tag}！来拼 → ${location.origin}/#/order/${d.order.id}`;
    navigator.clipboard?.writeText(txt).then(() => toast('已复制，去群里粘贴吧'), () => toast(txt, 6000));
  };
}

function askRemove(itemId, cn, d) {
  $sheet.innerHTML = `<form class="sheet" id="rmf">
    <h2>确认撤销「${esc(cn)}」的这件商品？</h2>
    <p>撤销后其余人的运费会重新计算。</p>
    <label for="rmpin" class="muted">输入 ${esc(cn)} 的 PIN（QQ 号后 4 位）</label>
    <input id="rmpin" class="pin-input" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" required autocomplete="off">
    <div class="grid2"><button type="button" class="btn line" id="rmcancel">取消</button><button class="btn dark">确认撤销</button></div>
  </form>`;
  $sheet.hidden = false;
  document.getElementById('rmpin').focus();
  document.getElementById('rmcancel').onclick = () => ($sheet.hidden = true);
  $sheet.onclick = (e) => { if (e.target === $sheet) $sheet.hidden = true; };
  document.getElementById('rmf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api(`/api/items/${itemId}/remove`, { method: 'POST', body: { pin: document.getElementById('rmpin').value } });
      $sheet.hidden = true;
      toast('已撤销');
      res.result.count ? renderOpen(res) : (location.hash = '#/');
    } catch (err) {
      toast(err.message);
    }
  };
}

function renderDone(d) {
  const r = d.result;
  const s = d.settle;
  const closed = d.order.status === 'closed';
  const when = d.order.done_at ? new Date(d.order.done_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  $app.innerHTML = `
  <header class="hero ${closed ? '' : 'ok'}" style="${closed ? 'background:var(--quiet)' : ''}">
    <div class="titlebar"><a class="back" href="#/" aria-label="返回">${backIcon}</a><h1>${esc(d.order.shop_name)}</h1></div>
    <div class="big"><b style="font-size:26px">${closed ? '已关闭' : '已成团'}</b></div>
    <span style="font-size:13px">${closed ? '团长已关闭这个拼单' : `${when} · ${d.order.mail_status === 'sent' ? '下单邮件已发送给代购' : `邮件未发出（${esc((d.order.mail_status || '').replace('failed:', ''))}）`}`}</span>
  </header>
  <main>
    <section class="list">
      <div class="list-head"><span>运费 ${jpy(r.fee)}${r.count ? ` · 每件 ${jpy(r.perItem)}` : ''}</span><span>应付</span></div>
      ${s.rows.map((x) => `<div class="li"><div class="mid"><b>${esc(x.member)}</b><span>${x.qty} 件 ${jpy(x.goods)} + 运费 ${jpy(x.shipping)}</span></div><b style="font-size:17px;font-weight:900">${jpy(x.total)}</b></div>`).join('')}
      <div class="total"><span style="font-weight:700">总计</span><b>${jpy(s.sum)}</b></div>
      ${s.rounding ? `<p class="muted" style="margin:0 0 10px">四舍五入差额 ${jpy(s.rounding)}</p>` : ''}
    </section>
    <div class="grid2"><button class="btn line" id="copy">复制链接清单</button><button class="btn line" id="csv">导出表格</button></div>
  </main>`;
  document.getElementById('copy').onclick = () => {
    const txt = d.items.map((i) => `${i.cn}\t${i.url}\t${jpy(i.price)} × ${i.qty}`).join('\n');
    navigator.clipboard?.writeText(txt).then(() => toast('已复制'), () => toast('复制失败，请手动选择'));
  };
  document.getElementById('csv').onclick = () => {
    const rows = [['CN', '商品', '链接', '单价', '数量'], ...d.items.map((i) => [i.cn, i.title || '', i.url, i.price, i.qty]), [], ['CN', '件数', '商品金额', '运费分摊', '应付'], ...s.rows.map((x) => [x.member, x.qty, x.goods, x.shipping, x.total])];
    const csv = '﻿' + rows.map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${d.order.shop_name}-分账.csv`;
    a.click();
  };
}

// ---------- 团长后台 ----------
async function admin() {
  let key = store.get('adminKey');
  if (!key) {
    $app.innerHTML = `<header class="hero"><div class="brand">团长后台</div></header>
      <main><form class="form" id="lg"><div class="field"><label for="k">管理口令</label><input id="k" type="password" required></div><button class="btn block">进入</button></form></main>`;
    document.getElementById('lg').onsubmit = (e) => {
      e.preventDefault();
      store.set('adminKey', document.getElementById('k').value);
      admin();
    };
    return;
  }
  const A = (path, opts = {}) => api(path, { ...opts, headers: { 'X-Admin-Key': key } });
  let g, list;
  try {
    [g, list] = await Promise.all([A('/api/admin/group'), api('/api/orders')]);
  } catch (e) {
    store.del('adminKey');
    toast(e.message);
    return admin();
  }
  $app.innerHTML = `
  <header class="hero"><div class="hero-top"><div class="brand">团长后台</div><a class="pill" style="color:#fff;text-decoration:none" href="#/">回首页</a></div></header>
  <main>
    <section class="card"><h3>团设置</h3>
      <div class="field"><label for="be">代购邮箱（成团邮件发到这里）</label><input id="be" type="email" value="${esc(g.buyer_email)}"></div>
      <div class="field"><label for="cc">抄送（可空）</label><input id="cc" type="email" value="${esc(g.cc_email || '')}"></div>
      <div class="field"><label for="pf">收货都道府县</label><input id="pf" value="${esc(g.prefecture)}"></div>
      <button class="btn" id="saveg">保存</button>
    </section>
    ${list.orders.map(adminOrder).join('') || '<p class="empty-state">暂无拼单</p>'}
    <section class="card"><h3>调试：查看骏和屋原始页面</h3>
      <div class="admin-row"><input class="wide" id="dbg" placeholder="骏和屋链接"><input id="dbgf" placeholder="定位文字（可空）"><button class="btn" id="dbgb">查看</button></div>
      <pre id="dbgo" style="white-space:pre-wrap;font-size:11px;max-height:300px;overflow:auto;margin:0"></pre>
    </section>
    <button class="btn line" id="logout">退出后台</button>
  </main>`;
  document.getElementById('saveg').onclick = async () => {
    await A('/api/admin/group', { method: 'PUT', body: { buyer_email: document.getElementById('be').value, cc_email: document.getElementById('cc').value || null, prefecture: document.getElementById('pf').value } });
    toast('已保存');
  };
  document.getElementById('logout').onclick = () => { store.del('adminKey'); location.hash = '#/'; };
  document.getElementById('dbgb').onclick = async () => {
    const res = await fetch(`/api/admin/debug/raw?url=${encodeURIComponent(document.getElementById('dbg').value)}&find=${encodeURIComponent(document.getElementById('dbgf').value)}`, { headers: { 'X-Admin-Key': key } });
    document.getElementById('dbgo').textContent = await res.text();
  };
  $app.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    const { act, id, shop } = b.dataset;
    try {
      if (act === 'tiers') {
        const fee = Number(document.getElementById(`fee-${id}`).value);
        const free = Number(document.getElementById(`free-${id}`).value);
        const tiers = [{ min: 0, fee }];
        if (free > 0) tiers.push({ min: free, fee: 0 });
        await A(`/api/admin/shops/${shop}`, { method: 'PUT', body: { tiers } });
      } else if (act === 'auto') {
        await A(`/api/admin/shops/${shop}`, { method: 'PUT', body: { tiers: null } });
      } else if (act === 'rmitem') {
        if (!confirm('移除这件商品？')) return;
        await A(`/api/admin/items/${id}`, { method: 'DELETE' });
      } else {
        if ((act === 'done' || act === 'close') && !confirm(act === 'done' ? '手动成团并立刻发邮件？' : '关闭这个拼单？')) return;
        const res = await A(`/api/admin/orders/${id}/${act}`, { method: 'POST' });
        if (res.mailStatus) toast(res.mailStatus === 'sent' ? '邮件已发送' : res.mailStatus, 4000);
      }
      toast('已更新');
      admin();
    } catch (e) {
      toast(e.message);
    }
  }));
}

function adminOrder(d) {
  const o = d.order;
  const r = d.result;
  const fee0 = d.tiers?.[0]?.fee ?? '';
  const free = freeThreshold(d.tiers) ?? '';
  return `<section class="card">
    <div class="card-head"><div><h3>${esc(o.shop_name)}</h3><span class="muted">店铺 ID ${esc(o.shop_id)} · ${o.status === 'open' ? '拼单中' : o.status === 'done' ? '已成团' : '已关闭'} · 运费来源：${{ auto: '自动抓取', manual: '手动', order: '本团单独', none: '未读到' }[d.tiersSource] || d.tiersSource}</span></div>
      <span class="tag ${r.success ? 'ok' : ''}">${r.count} 件 · ${jpy(r.subtotal)}</span></div>
    <div class="admin-row"><span class="muted">运费</span><input id="fee-${o.id}" type="number" value="${fee0}"><span class="muted">满</span><input id="free-${o.id}" type="number" placeholder="无门槛留空" value="${free}"><span class="muted">包邮</span>
      <button class="mini" data-act="tiers" data-id="${o.id}" data-shop="${esc(o.shop_id)}">保存为该店运费</button>
      <button class="mini" data-act="auto" data-id="${o.id}" data-shop="${esc(o.shop_id)}">恢复自动</button></div>
    ${d.items.map((i) => `<div class="admin-row"><span style="flex:1;font-size:13px">${esc(i.cn)} · ${jpy(i.price)} × ${i.qty} · <a href="${esc(i.url)}" target="_blank" rel="noopener">链接</a></span><button class="mini" data-act="rmitem" data-id="${i.id}">移除</button></div>`).join('')}
    <div class="admin-row">
      ${o.status === 'open' ? `<button class="mini" data-act="done" data-id="${o.id}">手动成团并发邮件</button><button class="mini" data-act="close" data-id="${o.id}">关团</button>` : `<button class="mini" data-act="reopen" data-id="${o.id}">重新打开</button><button class="mini" data-act="resend" data-id="${o.id}">重发邮件</button>`}
      ${o.mail_status ? `<span class="muted">邮件：${esc(o.mail_status)}</span>` : ''}
    </div></section>`;
}

route();
