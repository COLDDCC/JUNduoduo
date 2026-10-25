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

const subHead = (title) =>
  `<header class="lite-head sub"><div class="lite-row"><a class="lite-back" href="#/" aria-label="返回">${backIcon}</a><span class="lite-title">${esc(title)}</span></div></header>`;

function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(store.get('token') ? { 'X-Member-Token': store.get('token') } : {}),
      ...(store.get('adminKey') ? { 'X-Admin-Key': store.get('adminKey') } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** 团长导出 Excel：带口令请求，拿到文件后触发下载 */
async function downloadXlsx(orderId, btn) {
  if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = '生成中…'; }
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/export`, { headers: { 'X-Admin-Key': store.get('adminKey') || '' } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = m ? decodeURIComponent(m[1]) : '拼单.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    toast(`导出失败：${e.message}`, 4000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.t; }
  }
}

function describeTiers(tiers) {
  if (!tiers || !tiers.length) return '运费未知，等团长设置';
  const T = freeThreshold(tiers);
  if (tiers.length === 1) return tiers[0].fee === 0 ? '包邮' : `运费 ${jpy(tiers[0].fee)} · 无包邮`;
  if (T != null) return `满 ${jpy(T)} 包邮 · 不满运费 ${jpy(tiers[0].fee)}`;
  return tiers.map((t) => `${jpy(t.min)}起 ${jpy(t.fee)}`).join(' / ');
}

/** 统一的进度描述，首页卡片、选店、详情页共用。包邮按金额，均摊看每件运费是否在大家上限内 */
function progressView(r) {
  const people = `${r.members.length} 人 · ${r.count} 件`;
  const perItem = r.fee ? `每件运费 ${jpy(r.perItem)}` : '包邮';
  if (r.success) {
    return { tag: '可成团', ok: true, pct: 100, left: `${people} · ${jpy(r.subtotal)}`, right: perItem, headline: '<span>可成团</span>' };
  }
  const over = r.overCount ? `${r.overCount} 人超出运费上限` : '';
  if (r.needFreeYen != null) {
    return {
      tag: `差 ${jpy(r.needFreeYen)} 包邮`,
      pct: Math.min(100, (r.subtotal / r.threshold) * 100),
      left: `${people} · 已拼 <b>${jpy(r.subtotal)}</b>`,
      right: `满 ${jpy(r.threshold)} 包邮`,
      headline: `<span>还差</span><b>${jpy(r.needFreeYen).slice(1)}</b><span>日元包邮</span>`,
      sub: '',
    };
  }
  return {
    tag: r.overCount ? `${r.overCount} 人超上限` : '等人加入',
    pct: Math.min(100, r.splitProgress * 100),
    left: `${people} · ${jpy(r.subtotal)}`,
    right: perItem,
    headline: `<span>现在</span><b>${jpy(r.perItem).slice(1)}</b><span>日元/件 运费</span>`,
    sub: '',
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
  <header class="lite-head">
    <div class="lite-row"><span class="lite-brand">骏和屋拼单</span><span class="lite-meta" id="pref">大阪</span></div>
    <form class="lite-search" id="go" role="search">
      <input id="link" type="url" inputmode="url" placeholder="粘贴商品链接" aria-label="粘贴骏和屋商品链接" required>
      <button aria-label="开拼">${searchIcon}</button>
    </form>
  </header>
  <main id="list" class="lite-main"><p class="loading">读取中</p></main>`;
  const $link = document.getElementById('link');
  document.getElementById('go').onsubmit = (e) => {
    e.preventDefault();
    location.hash = `#/pick?url=${encodeURIComponent($link.value.trim())}`;
  };
  // 粘贴后直接跳转，省一次点击
  $link.addEventListener('paste', () => setTimeout(() => {
    if (/suruga-ya\.(jp|com)\/(?:[\w-]+\/)?product\//.test($link.value)) document.getElementById('go').requestSubmit();
  }, 0));
  const load = async () => {
    try {
      const d = await api('/api/orders');
      document.getElementById('pref').textContent = d.prefecture.replace(/[府県都]$/, '');
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
  const done = orders.filter((o) => ['done', 'ordered'].includes(o.order.status));
  const $list = document.getElementById('list');
  if (!$list) return;
  // 最接近成团的那家高亮
  open.sort((x, y) => progressView(y.result).pct - progressView(x.result).pct);
  const lead = open[0];
  $list.innerHTML = `
    <p class="lite-cap">拼单中 ${open.length}</p>
    <div class="pills">${open.length ? open.map((o) => shopPill(o, o === lead)).join('') : '<p class="lite-empty">暂无</p>'}</div>
    ${done.length ? `<p class="lite-cap">已成团 ${done.length}</p><div class="pills">${done.map((o) => shopPill(o, false, true)).join('')}</div>` : ''}`;
}

/** 一家店 = 一根胶囊：长度就是进度，右边一个数字 */
function shopPill(d, lead, done) {
  const r = d.result;
  const v = progressView(r);
  const iAmIn = d.me && r.members.some((m) => m.member === d.me);
  let unit, num;
  if (d.order.status === 'ordered') [unit, num] = ['', '已下单'];
  else if (done) [unit, num] = ['', '成团'];
  else if (r.success) [unit, num] = ['', '可成团'];
  else if (r.needFreeYen != null) [unit, num] = ['差', jpy(r.needFreeYen)];
  else [unit, num] = ['每件', jpy(r.perItem)];
  const w = done ? 100 : Math.round(74 + 0.26 * v.pct);
  return `<a class="pill${lead ? ' lead' : ''}${done ? ' done' : ''}${d.order.status === 'ordered' ? ' ordered' : ''}" href="#/order/${d.order.id}" style="width:${w}%">
    <span class="pill-l"><b>${esc(readableShopName(d.order))}</b><small>${r.members.length}人 · ${r.count}件 · ${jpy(r.subtotal)}${iAmIn ? ' · 我' : ''}</small></span>
    <span class="pill-r">${unit ? `<small>${unit}</small>` : ''}<span>${num}</span></span></a>`;
}

function whoLine(r) {
  return r.members.map((m) => `${esc(m.member)} ${m.qty}件 ${jpy(m.goods)}`).join('、');
}

const SHOP_DISPLAY_NAMES = { '400564': '駿河屋　四日市店', '200985': 'ブックマーケット函館美原店' };
function readableShopName(order) {
  return SHOP_DISPLAY_NAMES[String(order.shop_id)] || (order.shop_name && !/^店铺\s*\d+$/.test(order.shop_name) ? order.shop_name : '店铺 ' + order.shop_id);
}

function shopCard(d) {
  const r = d.result;
  const v = progressView(r);
  const iAmIn = d.me && r.members.some((m) => m.member === d.me);
  return `<a class="card link" href="#/order/${d.order.id}">
    <div class="card-head"><h3>${esc(readableShopName(d.order))}${iAmIn ? ' <span class="tag mine">我在拼</span>' : ''}</h3><span class="tag ${v.ok ? 'ok' : ''}">${v.tag}</span></div>
    <div class="bar sm"><i style="width:${v.pct}%"></i></div>
    <div class="who">${whoLine(r)}</div>
    <div class="meta"><span>合计 ${jpy(r.subtotal)}</span><span class="muted">${v.right}</span></div></a>`;
}

// ---------- 贴链接 → 选分店 ----------
async function pick(url) {
  $app.innerHTML = `${subHead('选择店铺')}<main class="lite-main"><p class="loading">读取中</p></main>`;
  const $main = $app.querySelector('main');
  let data;
  try {
    data = await api(`/api/scrape?url=${encodeURIComponent(url || '')}`);
  } catch (e) {
    $main.innerHTML = `<p class="lite-empty">${esc(e.message)}</p>`;
    return;
  }
  const L = data.listings.filter((l) => l.price != null);
  if (!L.length) {
    const message = data.listings.length
      ? '已找到商品和店铺，但未能读取价格。请打开原商品链接核对。'
      : '暂无可识别的在售店铺，请打开原商品链接确认库存。';
    $main.innerHTML = `<div class="product">${thumb(data.image, 'lg')}<div class="product-title">${esc(data.title || '骏河屋商品')}</div></div><p class="lite-empty">${esc(message)}</p><p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开骏河屋原页面 ↗</a></p>`;
    return;
  }
  const hint = data.hint || {};
  let sel = L.findIndex((l) => l.shopId === hint.shopId && l.branch === hint.branch);
  if (sel < 0) sel = 0;
  const me = { cn: store.get('cn') || '', qty: 1, cap: Number(store.get('cap') || 150) };

  const render = () => {
    const pinVal = document.getElementById('pin')?.value || '';
    $main.innerHTML = `
    <div class="product">${thumb(data.image, 'lg')}<div class="product-title">${esc(data.title || '骏和屋商品')}</div></div>
    <p class="lite-cap">在售 ${L.length}</p>
    <div class="pills">${L.map((l, i) => optCard(l, i === sel, me, i)).join('')}</div>
    <p class="preview-line">${previewOf(L[sel], me)}</p>
    <form class="lite-form" id="join">
      <div class="grid2">
        <label class="lf"><span>CN</span><input id="cn" maxlength="20" required value="${esc(me.cn)}"></label>
        <label class="lf"><span>QQ 后 4 位</span><input id="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required value="${esc(pinVal)}"></label>
      </div>
      <div class="grid2">
        <label class="lf"><span>运费上限</span><input id="cap" type="number" inputmode="numeric" min="0" step="10" value="${me.cap}"></label>
        <div class="lf"><span>数量</span><div class="stepper"><button type="button" id="minus" aria-label="减少">−</button><b>${me.qty}</b><button type="button" id="plus" aria-label="增加">+</button></div></div>
      </div>
      <button class="btn block" id="submit">加入</button>
    </form>`;
    const keep = () => {
      me.cn = document.getElementById('cn').value.trim();
      me.cap = Number(document.getElementById('cap').value) || 0;
    };
    $main.querySelectorAll('.opt').forEach((el) => (el.onclick = () => { keep(); sel = Number(el.dataset.i); render(); }));
    document.getElementById('cap').onchange = () => { keep(); render(); };
    document.getElementById('minus').onclick = () => { keep(); me.qty = Math.max(1, me.qty - 1); render(); };
    document.getElementById('plus').onclick = () => { keep(); me.qty = Math.min(20, me.qty + 1); render(); };
    document.getElementById('join').onsubmit = async (e) => {
      e.preventDefault();
      keep();
      const pin = document.getElementById('pin').value.trim();
      const btn = document.getElementById('submit');
      btn.disabled = true;
      try {
        const l = L[sel];
        const res = await api('/api/join', {
          method: 'POST',
          body: { url: l.url, shopId: l.shopId, branch: l.branch, cn: me.cn, pin, qty: me.qty, cap: me.cap },
        });
        store.set('cn', me.cn);
        if (res.token) store.set('token', res.token);
        store.set('cap', String(me.cap));
        toast(res.result.success ? '可成团' : '已加入');
        location.hash = `#/order/${res.order.id}`;
      } catch (err) {
        toast(err.message, 4000);
        btn.disabled = false;
      }
    };
  };
  render();
}

/** 选中店铺：加入后的结果，一行 */
function previewOf(l, me) {
  const p = l.progress;
  if (!l.tiers) return '运费待确认';
  const items = (p?.members || []).map((m) => ({ member: m.member, price: m.goods / m.qty, qty: m.qty }));
  const caps = Object.fromEntries((p?.members || []).map((m) => [m.member, m.cap]));
  const self = me.cn || '我';
  items.push({ member: self, price: l.price, qty: me.qty });
  caps[self] = me.cap;
  const after = evaluate({ items, caps, tiers: l.tiers });
  const mine = after.members.find((m) => m.member === self);
  if (after.success) return after.reason === 'free' ? '加入后包邮成团' : `加入后成团 · 每件运费 ${jpy(after.perItem)}`;
  if (after.needFreeYen != null) return `加入后差 ${jpy(after.needFreeYen)} 包邮`;
  return `加入后每件运费 ${jpy(after.perItem)}${mine.ok ? '' : ' · 超出你的上限'}`;
}

function optCard(l, selected, me, idx) {
  const p = l.progress;
  const people = p ? `${p.members.length}人在拼 · ` : '';
  return `<button type="button" class="pill opt${selected ? ' lead' : ''}" data-i="${idx}" style="width:100%">
    <span class="pill-l"><b>${esc(l.shopName)}</b><small>${people}${describeTiers(l.tiers)}${l.condition && l.condition !== '中古' ? ` · ${esc(l.condition)}` : ''}</small></span>
    <span class="pill-r"><span>${jpy(l.price)}</span></span></button>`;
}

// ---------- 拼单详情 / 撤销 / 成团分账 ----------
async function order(id) {
  $app.innerHTML = `${subHead('')}<main class="lite-main"><p class="loading">读取中</p></main>`;
  const load = async () => {
    try {
      const d = await api(`/api/orders/${id}`);
      if (!$sheet.hidden) return;
      d.order.status === 'open' ? renderOpen(d) : renderDone(d);
      if (d.order.status !== 'open') clearInterval(timer);
    } catch (e) {
      $app.innerHTML = `${subHead('')}<main class="lite-main"><p class="lite-empty">${esc(e.message)}</p></main>`;
    }
  };
  await load();
  timer = setInterval(load, 10000);
}

/** 详情页顶部：一个大数字 + 一行说明 + 进度 */
function statBlock(r) {
  const v = progressView(r);
  let cap, num, sub;
  if (r.success) [cap, num, sub] = ['可成团', jpy(r.subtotal), `${r.fee ? `每件运费 ${jpy(r.perItem)}` : '包邮'} · 等待团长确认`];
  else if (r.needFreeYen != null) [cap, num, sub] = ['差', jpy(r.needFreeYen), `满 ${jpy(r.threshold)} 包邮`];
  else {
    const t = r.targetPerItem;
    [cap, num, sub] = ['每件运费', jpy(r.perItem), t > 0 ? `降到 ${jpy(Math.floor(t))} 成团` : '需团长处理'];
  }
  return `<section class="stat"><small>${cap}</small><b>${num}</b><span>${sub}</span></section>
    <div class="track"><i style="width:${Math.max(4, v.pct)}%"></i></div>
    <div class="stat-meta"><span>${r.members.length}人 · ${r.count}件 · ${jpy(r.subtotal)}</span><span>${r.okCount}/${r.members.length} 达标</span></div>`;
}

const itemRows = (items, showCn, removable) =>
  items
    .map(
      (i) => `<div class="row item">${thumb(i.image)}<a class="row-l" href="${esc(i.url)}" target="_blank" rel="noopener"><b>${showCn ? `${esc(i.cn)} · ` : ''}${esc(i.title || '商品')}</b><small>${jpy(i.price)} × ${i.qty}</small></a>${removable ? `<button class="link-btn" data-rm="${i.id}">撤销</button>` : ''}</div>`,
    )
    .join('');

function renderOpen(d) {
  const r = d.result;
  const v = progressView(r);
  const me = d.me;
  $app.innerHTML = `
  ${subHead(readableShopName(d.order))}
  <main class="lite-main">
    <p class="lite-cap">店铺 ID：${esc(d.order.shop_id)}</p>
    ${statBlock(r)}
    <div class="rows">
      ${r.members
        .map(
          (m) => `<div class="row"><span class="row-l"><b>${esc(m.member)}${m.member === me ? ' · 我' : ''}</b><small>${m.qty}件 · ${jpy(m.goods)}</small></span>
          <span class="row-r${m.ok ? '' : ' over'}"><small>上限 ${jpy(m.cap)}</small><span>${jpy(m.share)}</span></span></div>`,
        )
        .join('')}
    </div>
    ${d.items.length ? `<p class="lite-cap">${d.admin ? '全部物品' : '我的物品'}</p><div class="rows white">${itemRows(d.items, d.admin, true)}</div>` : ''}
    ${!me && !d.admin ? `<button class="btn line block" id="login">我的物品</button>` : ''}
    ${d.admin ? `<button class="btn block${r.success ? '' : ' line'}" id="confirm">成团并发邮件</button><button class="btn line block" id="xlsx">导出 Excel</button>` : ''}
    <button class="btn block${d.admin ? ' line' : ''}" id="share">复制链接</button>
  </main>`;
  document.getElementById('confirm')?.addEventListener('click', () => askConfirm(d));
  document.getElementById('xlsx')?.addEventListener('click', (e) => downloadXlsx(d.order.id, e.currentTarget));
  $app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => askRemove(b.dataset.rm)));
  document.getElementById('login')?.addEventListener('click', askLogin);
  document.getElementById('share').onclick = () => {
    const txt = `【骏和屋拼单】${readableShopName(d.order)}：${r.members.length}人 ${r.count}件，${v.tag} → ${location.origin}/#/order/${d.order.id}`;
    navigator.clipboard?.writeText(txt).then(() => toast('已复制'), () => toast(txt, 6000));
  };
}

function openSheet(html) {
  $sheet.innerHTML = html;
  $sheet.hidden = false;
  $sheet.onclick = (e) => { if (e.target === $sheet) $sheet.hidden = true; };
  $sheet.querySelector('[data-close]')?.addEventListener('click', () => ($sheet.hidden = true));
}

function askLogin() {
  openSheet(`<form class="sheet" id="lgf">
    <h2>我的物品</h2>
    <div class="grid2">
      <label class="lf"><span>CN</span><input id="lcn" required value="${esc(store.get('cn') || '')}"></label>
      <label class="lf"><span>QQ 后 4 位</span><input id="lpin" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" required></label>
    </div>
    <div class="grid2"><button type="button" class="btn line" data-close>取消</button><button class="btn">确认</button></div>
  </form>`);
  document.getElementById('lcn').focus();
  document.getElementById('lgf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/login', { method: 'POST', body: { cn: document.getElementById('lcn').value.trim(), pin: document.getElementById('lpin').value } });
      store.set('token', res.token);
      store.set('cn', res.cn);
      $sheet.hidden = true;
      route();
    } catch (err) {
      toast(err.message);
    }
  };
}

function askConfirm(d) {
  const r = d.result;
  openSheet(`<div class="sheet">
    <h2>成团并发邮件</h2>
    <p>${r.members.length}人 · ${r.count}件 · ${jpy(r.subtotal)} · ${r.fee ? `运费 ${jpy(r.fee)}` : '包邮'}${r.success ? '' : ' · 未满足条件'}</p>
    <div class="grid2"><button type="button" class="btn line" data-close>取消</button><button class="btn" id="cfok">成团</button></div>
  </div>`);
  document.getElementById('cfok').onclick = async () => {
    try {
      const res = await api(`/api/admin/orders/${d.order.id}/done`, { method: 'POST' });
      $sheet.hidden = true;
      toast(res.mailStatus === 'sent' ? '已成团，邮件已发送' : '已成团，邮件未发出');
      route();
    } catch (err) {
      toast(err.message);
    }
  };
}

function askRemove(itemId) {
  openSheet(`<div class="sheet">
    <h2>撤销这件物品</h2>
    <div class="grid2"><button type="button" class="btn line" data-close>取消</button><button class="btn danger" id="rmok">撤销</button></div>
  </div>`);
  document.getElementById('rmok').onclick = async () => {
    try {
      const res = await api(`/api/items/${itemId}/remove`, { method: 'POST', body: {} });
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
  const ordered = d.order.status === 'ordered';
  const when = d.order.done_at ? new Date(d.order.done_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const mailOk = d.order.mail_status === 'sent';
  $app.innerHTML = `
  ${subHead(readableShopName(d.order))}
  <main class="lite-main">
    <p class="lite-cap">店铺 ID：${esc(d.order.shop_id)}</p>
    <section class="stat ${closed ? 'muted' : 'ok'}"><small>${closed ? '已关闭' : ordered ? `已下单 · 单号 ${esc(d.order.order_no)}` : `已成团 · ${when}`}</small><b>${jpy(s.sum)}</b><span>${r.fee ? `运费 ${jpy(r.fee)} · 每件 ${jpy(r.perItem)}` : '包邮'}${closed || mailOk ? '' : ' · 邮件未发出'}</span></section>
    <div class="rows">
      ${s.rows.map((x) => `<div class="row"><span class="row-l"><b>${esc(x.member)}${x.member === d.me ? ' · 我' : ''}</b><small>${x.qty}件 ${jpy(x.goods)} + 运费 ${jpy(x.shipping)}</small></span><span class="row-r"><span>${jpy(x.total)}</span></span></div>`).join('')}
    </div>
    ${d.items.length ? `<p class="lite-cap">${d.admin ? '全部物品' : '我的物品'}</p><div class="rows white">${itemRows(d.items, d.admin, false)}</div>` : ''}
    ${d.admin && !closed ? `<form class="lite-form" id="ono"><label class="lf"><span>单号</span><input id="onoin" required maxlength="64" value="${esc(d.order.order_no || '')}"></label><button class="btn block">${ordered ? '更新单号' : '已下单'}</button></form>` : ''}
    ${d.admin ? `<div class="grid2"><button class="btn line" id="copy">复制清单</button><button class="btn line" id="xlsx">导出 Excel</button></div>` : ''}
  </main>`;
  document.getElementById('ono')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api(`/api/admin/orders/${d.order.id}/ordered`, { method: 'POST', body: { orderNo: document.getElementById('onoin').value } });
      toast('已下单');
      renderDone(res);
    } catch (err) {
      toast(err.message);
    }
  });
  if (!d.admin) return;
  document.getElementById('copy').onclick = () => {
    const txt = d.items.map((i) => `${i.cn}\t${i.url}\t${jpy(i.price)} × ${i.qty}`).join('\n');
    navigator.clipboard?.writeText(txt).then(() => toast('已复制'), () => toast('复制失败'));
  };
  document.getElementById('xlsx').onclick = (e) => downloadXlsx(d.order.id, e.currentTarget);
}

// ---------- 团长后台 ----------
async function admin() {
  let key = store.get('adminKey');
  if (!key) {
    $app.innerHTML = `${subHead('团长后台')}
      <main class="lite-main"><form class="lite-form" id="lg"><label class="lf"><span>口令</span><input id="k" type="password" required></label><button class="btn block">进入</button></form></main>`;
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
    [g, list] = await Promise.all([A('/api/admin/group'), A('/api/admin/orders')]);
  } catch (e) {
    store.del('adminKey');
    toast(e.message);
    return admin();
  }
  $app.innerHTML = `
  ${subHead('团长后台')}
  <main class="lite-main">
    <section class="card"><h3>团设置</h3>
      <div class="field"><label for="be">代购邮箱（成团邮件发到这里）</label><input id="be" type="email" value="${esc(g.buyer_email)}"></div>
      <div class="field"><label for="cc">抄送（可空）</label><input id="cc" type="email" value="${esc(g.cc_email || '')}"></div>
      <div class="field"><label for="pf">收货都道府县</label><input id="pf" value="${esc(g.prefecture)}"></div>
      <button class="btn" id="saveg">保存</button>
    </section>
    <section class="card"><h3>重置 QQ 后 4 位</h3>
      <form class="admin-row" id="rp"><input class="wide" id="rpcn" placeholder="CN" required><input id="rppin" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="新的 4 位" required><button class="btn">重置</button></form>
    </section>
    ${list.orders.map(adminOrder).join('') || '<p class="empty-state">暂无拼单</p>'}
    <section class="card"><h3>原始页面</h3>
      <div class="admin-row"><input class="wide" id="dbg" placeholder="骏和屋链接"><input id="dbgf" placeholder="关键字"><button class="btn" id="dbgb">查看</button></div>
      <pre id="dbgo" style="white-space:pre-wrap;font-size:11px;max-height:300px;overflow:auto;margin:0"></pre>
    </section>
    <button class="btn line" id="logout">退出后台</button>
  </main>`;
  document.getElementById('saveg').onclick = async () => {
    await A('/api/admin/group', { method: 'PUT', body: { buyer_email: document.getElementById('be').value, cc_email: document.getElementById('cc').value || null, prefecture: document.getElementById('pf').value } });
    toast('已保存');
  };
  document.getElementById('rp').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await A('/api/admin/members/reset-pin', { method: 'POST', body: { cn: document.getElementById('rpcn').value.trim(), pin: document.getElementById('rppin').value } });
      toast('已重置');
      e.target.reset();
    } catch (err) {
      toast(err.message);
    }
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
      } else if (act === 'xlsx') {
        return downloadXlsx(id, b);
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
    <div class="card-head"><div><h3>${esc(readableShopName(o))}</h3><span class="muted">店铺 ID ${esc(o.shop_id)} · ${{ open: '拼单中', done: '已成团', ordered: `已下单 ${esc(o.order_no || '')}`, closed: '已关闭' }[o.status] || o.status} · 运费来源：${{ auto: '自动抓取', manual: '手动', order: '本团单独', none: '未读到' }[d.tiersSource] || d.tiersSource}</span></div>
      <span class="tag ${r.success ? 'ok' : ''}">${r.count} 件 · ${jpy(r.subtotal)}</span></div>
    <div class="admin-row"><span class="muted">运费</span><input id="fee-${o.id}" type="number" value="${fee0}"><span class="muted">满</span><input id="free-${o.id}" type="number" placeholder="—" value="${free}"><span class="muted">包邮</span>
      <button class="mini" data-act="tiers" data-id="${o.id}" data-shop="${esc(o.shop_id)}">保存为该店运费</button>
      <button class="mini" data-act="auto" data-id="${o.id}" data-shop="${esc(o.shop_id)}">恢复自动</button></div>
    ${d.items.length ? `<div class="rows white">${d.items.map((i) => `<div class="row item">${thumb(i.image)}<a class="row-l" href="${esc(i.url)}" target="_blank" rel="noopener"><b>${esc(i.cn)} · ${esc(i.title || '商品')}</b><small>${jpy(i.price)} × ${i.qty}</small></a><button class="link-btn" data-act="rmitem" data-id="${i.id}">移除</button></div>`).join('')}</div>` : '<p class="muted">没有物品</p>'}
    <div class="admin-row">
      ${o.status === 'open' ? `<button class="mini" data-act="done" data-id="${o.id}">手动成团并发邮件</button><button class="mini" data-act="close" data-id="${o.id}">关团</button>` : `<button class="mini" data-act="reopen" data-id="${o.id}">重新打开</button><button class="mini" data-act="resend" data-id="${o.id}">重发邮件</button>`}
      ${d.items.length ? `<button class="mini" data-act="xlsx" data-id="${o.id}">导出 Excel</button>` : ''}
      ${o.mail_status ? `<span class="muted">邮件：${esc(o.mail_status)}</span>` : ''}
    </div></section>`;
}

route();
