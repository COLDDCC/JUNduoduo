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
    return { tag: '可成团', ok: true, pct: 100, left: `${people} · ${jpy(r.subtotal)}`, right: perItem, headline: '<span>已成团</span>' };
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
    if (/suruga-ya\.jp\/product\//.test($link.value)) document.getElementById('go').requestSubmit();
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
  const done = orders.filter((o) => o.order.status === 'done');
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
  if (done || r.success) [unit, num] = ['', '成团'];
  else if (r.needFreeYen != null) [unit, num] = ['差', jpy(r.needFreeYen)];
  else [unit, num] = ['每件', jpy(r.perItem)];
  const w = done ? 100 : Math.round(74 + 0.26 * v.pct);
  return `<a class="pill${lead ? ' lead' : ''}${done ? ' done' : ''}" href="#/order/${d.order.id}" style="width:${w}%">
    <span class="pill-l"><b>${esc(d.order.shop_name)}</b><small>${r.members.length}人 · ${r.count}件 · ${jpy(r.subtotal)}${iAmIn ? ' · 我' : ''}</small></span>
    <span class="pill-r">${unit ? `<small>${unit}</small>` : ''}<span>${num}</span></span></a>`;
}

function whoLine(r) {
  return r.members.map((m) => `${esc(m.member)} ${m.qty}件 ${jpy(m.goods)}`).join('、');
}

function shopCard(d) {
  const r = d.result;
  const v = progressView(r);
  const iAmIn = d.me && r.members.some((m) => m.member === d.me);
  return `<a class="card link" href="#/order/${d.order.id}">
    <div class="card-head"><h3>${esc(d.order.shop_name)}${iAmIn ? ' <span class="tag mine">我在拼</span>' : ''}</h3><span class="tag ${v.ok ? 'ok' : ''}">${v.tag}</span></div>
    <div class="bar sm"><i style="width:${v.pct}%"></i></div>
    <div class="who">${whoLine(r)}</div>
    <div class="meta"><span>合计 ${jpy(r.subtotal)}</span><span class="muted">${v.right}</span></div></a>`;
}

// ---------- 贴链接 → 选分店 ----------
async function pick(url) {
  $app.innerHTML = `
  <header class="hero" style="background:#fff;color:var(--ink);padding:10px 16px;border-bottom:1px solid #EDE6E0">
    <div class="titlebar"><a class="back" href="#/" aria-label="返回">${backIcon}</a><h1>选一家店加入</h1></div>
  </header>
  <main style="margin-top:0"><p class="loading">读取中…</p></main>`;
  const $main = $app.querySelector('main');
  let data;
  try {
    data = await api(`/api/scrape?url=${encodeURIComponent(url || '')}`);
  } catch (e) {
    $main.innerHTML = `<p class="empty-state">${esc(e.message)}</p><a class="btn block" href="#/">返回</a>`;
    return;
  }
  const L = data.listings.filter((l) => l.price != null);
  if (!L.length) {
    $main.innerHTML = '<p class="empty-state">暂无在售</p><a class="btn block" href="#/">返回</a>';
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
      btn.textContent = '提交中';
      try {
        const l = L[sel];
        const res = await api('/api/join', {
          method: 'POST',
          body: { url: l.url, shopId: l.shopId, branch: l.branch, cn: me.cn, pin, qty: me.qty, cap: me.cap },
        });
        store.set('cn', me.cn);
        if (res.token) store.set('token', res.token);
        store.set('cap', String(me.cap));
        toast(res.order.status === 'done' ? '已成团' : '加入成功');
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
  let preview = '运费待确认';
  if (after) {
    const mine = after.members.find((m) => m.member === self);
    if (after.success) preview = after.reason === 'free' ? `你加入后：${jpy(after.subtotal)} · 直接包邮成团` : `你加入后：每件运费 ${jpy(after.perItem)} · 直接成团`;
    else if (after.needFreeYen != null) preview = `你加入后：已拼 ${jpy(after.subtotal)} · 还差 ${jpy(after.needFreeYen)} 包邮`;
    else preview = `你加入后：每件运费 ${jpy(after.perItem)}，你分摊 ${jpy(mine.share)}${mine.ok ? '' : '（超出你的上限）'}`;
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

/** 详情页顶部：一句结论 + 两个数字对比 + 进度条 + 达标人数 */
function heroBlock(r, tiers) {
  const v = progressView(r);
  let title, a, b, foot;
  if (r.success) {
    title = '已成团';
    a = ['已拼', jpy(r.subtotal)];
    b = ['运费', r.fee ? `${jpy(r.perItem)}/件` : '包邮'];
  } else if (r.needFreeYen != null) {
    title = `还差 ${jpy(r.needFreeYen)} 包邮`;
    a = ['已拼', jpy(r.subtotal)];
    b = ['包邮线', jpy(r.threshold)];
  } else {
    const t = r.targetPerItem;
    title = t > 0 ? `每件运费降到 ${jpy(Math.floor(t))} 以下就成团` : '等待团长处理';
    a = ['现在每件运费', jpy(r.perItem)];
    b = ['大家能接受', t > 0 ? `≤ ${jpy(Math.floor(t))}` : '—'];
  }
  foot = `${r.members.length} 人 · ${r.count} 件 · ${r.okCount}/${r.members.length} 人运费在上限内`;
  return `
    <div class="hero-title">${title}</div>
    <div class="vs">
      <div><span>${a[0]}</span><b>${a[1]}</b></div>
      <i aria-hidden="true">→</i>
      <div><span>${b[0]}</span><b>${b[1]}</b></div>
    </div>
    <div class="bar" style="background:rgba(255,255,255,.28)"><i style="width:${v.pct}%;background:#fff"></i></div>
    <div class="hero-meta"><span>${foot}</span><span>${describeTiers(tiers)}</span></div>`;
}

function renderOpen(d) {
  const r = d.result;
  const v = progressView(r);
  const me = d.me;
  $app.innerHTML = `
  <header class="hero">
    <div class="titlebar"><a class="back" href="#/" aria-label="返回">${backIcon}</a><h1>${esc(d.order.shop_name)}</h1></div>
    ${heroBlock(r, d.tiers)}
  </header>
  <main>
    <section class="list">
      <div class="list-head"><span>谁在拼</span><span>分摊运费 / 上限</span></div>
      ${r.members
        .map(
          (m) => `<div class="li"><div class="mid"><b>${esc(m.member)}${m.member === me ? '（我）' : ''}</b><span>${m.qty} 件 · ${jpy(m.goods)}</span></div>
          <div class="end"><b>${jpy(m.share)}</b>${m.ok ? `<span class="good">≤ ${jpy(m.cap)} 达标</span>` : `<span class="bad">超出上限 ${jpy(m.cap)}</span>`}</div></div>`,
        )
        .join('')}
    </section>
    ${
      d.items.length
        ? `<section class="list"><div class="list-head"><span>${me ? '我的物品' : '全部物品'}</span><span></span></div>
          ${d.items.map((i) => `<div class="sub">${thumb(i.image)}<a href="${esc(i.url)}" target="_blank" rel="noopener" class="sub-t">${me ? '' : `${esc(i.cn)} · `}${esc(i.title || '商品')}<br><b>${jpy(i.price)} × ${i.qty}</b></a><button class="mini" data-rm="${i.id}">撤销</button></div>`).join('')}</section>`
        : `<button class="btn line block" id="login">查看 / 撤销我的物品</button>`
    }
    <button class="btn block" id="share">复制链接发到群里</button>
  </main>`;
  $app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => askRemove(b.dataset.rm)));
  document.getElementById('login')?.addEventListener('click', askLogin);
  document.getElementById('share').onclick = () => {
    const txt = `【骏和屋拼单】${d.order.shop_name}：${r.members.length} 人 ${r.count} 件，${v.tag}！来拼 → ${location.origin}/#/order/${d.order.id}`;
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
    <h2>查看我的物品</h2>
    <div class="grid2">
      <div class="field"><label for="lcn">CN</label><input id="lcn" required value="${esc(store.get('cn') || '')}"></div>
      <div class="field"><label for="lpin">QQ 号后 4 位</label><input id="lpin" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" required></div>
    </div>
    <div class="grid2"><button type="button" class="btn line" data-close>取消</button><button class="btn">确认</button></div>
  </form>`);
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

function askRemove(itemId) {
  openSheet(`<div class="sheet">
    <h2>撤销这件物品？</h2>
    <div class="grid2"><button type="button" class="btn line" data-close>取消</button><button class="btn dark" id="rmok">确认撤销</button></div>
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
  const when = d.order.done_at ? new Date(d.order.done_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  $app.innerHTML = `
  <header class="hero ${closed ? '' : 'ok'}" style="${closed ? 'background:var(--quiet)' : ''}">
    <div class="titlebar"><a class="back" href="#/" aria-label="返回">${backIcon}</a><h1>${esc(d.order.shop_name)}</h1></div>
    <div class="big"><b style="font-size:26px">${closed ? '已关闭' : '已成团'}</b></div>
    <span style="font-size:13px">${closed ? '团长已关闭这个拼单' : `${when} · ${d.order.mail_status === 'sent' ? '下单邮件已发送给代购' : `邮件未发出（${esc((d.order.mail_status || '').replace('failed:', ''))}）`}`}</span>
  </header>
  <main>
    <section class="list">
      <div class="list-head"><span>运费 ${jpy(r.fee)}${r.fee ? ` · 每件 ${jpy(r.perItem)}` : ''}</span><span>应付</span></div>
      ${s.rows.map((x) => `<div class="li"><div class="mid"><b>${esc(x.member)}</b><span>${x.qty} 件 ${jpy(x.goods)} + 运费 ${jpy(x.shipping)}</span></div><b style="font-size:17px;font-weight:900">${jpy(x.total)}</b></div>`).join('')}
      <div class="total"><span style="font-weight:700">总计</span><b>${jpy(s.sum)}</b></div>
      ${s.rounding ? `<p class="muted" style="margin:0 0 10px">四舍五入差额 ${jpy(s.rounding)}</p>` : ''}
    </section>
    ${d.items.length ? `<section class="list"><div class="list-head"><span>${d.me ? '我的物品' : '全部物品'}</span><span></span></div>${d.items.map((i) => `<div class="sub">${thumb(i.image)}<a href="${esc(i.url)}" target="_blank" rel="noopener" class="sub-t">${d.me ? '' : `${esc(i.cn)} · `}${esc(i.title || '商品')}<br><b>${jpy(i.price)} × ${i.qty}</b></a></div>`).join('')}</section>` : ''}
    ${store.get('adminKey') ? `<div class="grid2"><button class="btn line" id="copy">复制链接清单</button><button class="btn line" id="csv">导出表格</button></div>` : ''}
  </main>`;
  if (!store.get('adminKey')) return;
  document.getElementById('copy').onclick = () => {
    const txt = d.items.map((i) => `${i.cn}\t${i.url}\t${jpy(i.price)} × ${i.qty}`).join('\n');
    navigator.clipboard?.writeText(txt).then(() => toast('已复制'), () => toast('复制失败'));
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
    <div class="admin-row"><span class="muted">运费</span><input id="fee-${o.id}" type="number" value="${fee0}"><span class="muted">满</span><input id="free-${o.id}" type="number" placeholder="—" value="${free}"><span class="muted">包邮</span>
      <button class="mini" data-act="tiers" data-id="${o.id}" data-shop="${esc(o.shop_id)}">保存为该店运费</button>
      <button class="mini" data-act="auto" data-id="${o.id}" data-shop="${esc(o.shop_id)}">恢复自动</button></div>
    ${d.items.map((i) => `<div class="admin-row"><span style="flex:1;font-size:13px">${esc(i.cn)} · ${jpy(i.price)} × ${i.qty} · <a href="${esc(i.url)}" target="_blank" rel="noopener">链接</a></span><button class="mini" data-act="rmitem" data-id="${i.id}">移除</button></div>`).join('')}
    <div class="admin-row">
      ${o.status === 'open' ? `<button class="mini" data-act="done" data-id="${o.id}">手动成团并发邮件</button><button class="mini" data-act="close" data-id="${o.id}">关团</button>` : `<button class="mini" data-act="reopen" data-id="${o.id}">重新打开</button><button class="mini" data-act="resend" data-id="${o.id}">重发邮件</button>`}
      ${o.mail_status ? `<span class="muted">邮件：${esc(o.mail_status)}</span>` : ''}
    </div></section>`;
}

route();
