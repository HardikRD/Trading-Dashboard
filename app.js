/* Trade ledger — multi-account, multi-strategy P&L dashboard for Zerodha tradebooks.
   Everything runs in the browser; data is kept in localStorage. */
(() => {
'use strict';

const STORE = 'trade-ledger:v1';
const PAGE = 100;
const PALETTE = ['#2F4DA8', '#0E8A6A', '#C2410C', '#7C3AED', '#B45309', '#0369A1', '#BE185D', '#4D7C0F'];

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v, sign = true) => {
  const r = Math.round(v);
  const s = r < 0 ? '−' : (sign && r > 0 ? '+' : '');
  return s + '₹' + inr0.format(Math.abs(r));
};
const tone = v => v > 0.5 ? 'pos' : v < -0.5 ? 'neg' : '';
const pct = v => v == null ? '–' : (v * 100).toFixed(1) + '%';
const ratio = v => v == null ? '–' : v === Infinity ? '∞' : v.toFixed(2);
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const plural = (n, w) => `${inr0.format(n)} ${n === 1 ? w : w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's'}`;
const compact = v => {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e7) return s + (a / 1e7).toFixed(1) + 'Cr';
  if (a >= 1e5) return s + (a / 1e5).toFixed(1) + 'L';
  if (a >= 1e3) return s + (a / 1e3).toFixed(0) + 'k';
  return s + a.toFixed(0);
};
const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function parseDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : ymd(d);
}

/* ---------- state ---------- */
const blank = () => ({ accounts: [], strategies: [], rules: [], adjustments: [], trades: [] });
let S = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return Object.assign(blank(), JSON.parse(raw));
  } catch (e) { /* fall through to empty state */ }
  return blank();
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); }
  catch (e) { toast('Could not save: browser storage is full or blocked. Export a backup now.'); }
}

const F = { account: '', strategy: '', segment: '', from: '', to: '' };
let page = 0, search = '', curveMode = 'total', breakdownBy = 'strategy';
let selected = new Set(), pageIds = [], openCache = [];
const charts = {};

const accName = id => S.accounts.find(a => a.id === id)?.name || 'Unknown account';
const strat = id => S.strategies.find(s => s.id === id);
const stratName = id => strat(id)?.name || 'Unassigned';
const stratColor = id => strat(id)?.color || '#8A94A3';
const accColor = id => PALETTE[Math.max(0, S.accounts.findIndex(a => a.id === id)) % PALETTE.length];

/* ---------- CSV import ---------- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const norm = h => h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s.]+/g, '_');

function mapRow(o) {
  const g = (...ks) => { for (const k of ks) if (o[k]) return o[k]; return ''; };
  const symbol = g('symbol', 'tradingsymbol').toUpperCase();
  const date = parseDate(g('trade_date', 'date'));
  const side = g('trade_type', 'transaction_type', 'type').toLowerCase();
  const qty = Math.abs(parseFloat(g('quantity', 'qty').replace(/,/g, '')));
  const price = parseFloat(g('price', 'average_price').replace(/,/g, ''));
  if (!symbol || !date || (side !== 'buy' && side !== 'sell') || !(qty > 0) || !(price >= 0)) return null;
  const tm = g('order_execution_time', 'trade_time', 'time').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const time = date + 'T' + (tm ? `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}` : '00:00:00');
  return {
    symbol, date, time, side, qty, price,
    segment: g('segment').toUpperCase(), exchange: g('exchange').toUpperCase(),
    tradeId: g('trade_id'), orderId: g('order_id'),
  };
}

function ruleMatcher(p) {
  p = p.trim().toUpperCase();
  const body = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(p.includes('*') ? `^${body}$` : body);
}
function applyRules(symbol, accountId) {
  for (const r of S.rules) {
    if (r.accountId && r.accountId !== accountId) continue;
    try { if (ruleMatcher(r.pattern).test(symbol)) return r.strategyId; } catch (e) { /* bad pattern */ }
  }
  return null;
}

async function doImport() {
  const accId = $('#iAccount').value;
  if (!accId) { toast('Add an account in Setup before importing.'); return; }
  const files = [...$('#iFile').files];
  if (!files.length) { toast('Choose one or more tradebook CSV files.'); return; }
  const forced = $('#iStrategy').value || null;
  const seen = new Set(S.trades.map(t => `${t.accountId}|${t.exchange}|${t.tradeId}`));
  let added = 0, dup = 0, bad = 0; const rejected = [];

  for (const file of files) {
    const rows = parseCSV(await file.text());
    const hi = rows.findIndex(r => {
      const h = r.map(norm);
      return h.includes('symbol') && (h.includes('trade_type') || h.includes('transaction_type'));
    });
    if (hi < 0) { rejected.push(file.name); continue; }
    const head = rows[hi].map(norm);
    for (const r of rows.slice(hi + 1)) {
      const o = {}; head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
      const t = mapRow(o);
      if (!t) { bad++; continue; }
      const key = `${accId}|${t.exchange}|${t.tradeId}`;
      if (t.tradeId && seen.has(key)) { dup++; continue; }
      seen.add(key);
      t.id = uid(); t.accountId = accId;
      t.strategyId = forced || applyRules(t.symbol, accId);
      S.trades.push(t); added++;
    }
  }
  save(); renderAll();
  let msg = `Imported ${plural(added, 'trade')} into ${accName(accId)}.`;
  if (dup) msg += ` Skipped ${plural(dup, 'trade')} already imported.`;
  if (bad) msg += ` Ignored ${plural(bad, 'row')} that weren't trades.`;
  if (rejected.length) msg += ` Could not read ${rejected.join(', ')}: no symbol and trade_type columns found.`;
  $('#importResult').textContent = msg;
  $('#iFile').value = '';
}

/* ---------- P&L engine: FIFO per account + strategy + symbol ---------- */
function engine() {
  const groups = new Map();
  for (const t of S.trades) {
    const k = `${t.accountId}|${t.strategyId || ''}|${t.symbol}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const closes = [], open = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
    const f = list[0], lots = [];
    for (const t of list) {
      let q = t.side === 'buy' ? t.qty : -t.qty, pnl = 0, matched = 0;
      while (q !== 0 && lots.length && Math.sign(lots[0].q) !== Math.sign(q)) {
        const lot = lots[0];
        const m = Math.min(Math.abs(q), Math.abs(lot.q));
        pnl += lot.q > 0 ? (t.price - lot.p) * m : (lot.p - t.price) * m;
        matched += m;
        lot.q += lot.q > 0 ? -m : m;
        q += q > 0 ? -m : m;
        if (Math.abs(lot.q) < 1e-9) lots.shift();
        if (Math.abs(q) < 1e-9) q = 0;
      }
      if (q !== 0) lots.push({ q, p: t.price });
      if (matched) closes.push({ accountId: f.accountId, strategyId: f.strategyId || null, symbol: f.symbol, segment: f.segment, date: t.date, pnl, qty: matched });
    }
    const net = lots.reduce((s, l) => s + l.q, 0);
    if (Math.abs(net) > 1e-9) {
      const avg = lots.reduce((s, l) => s + l.q * l.p, 0) / net;
      open.push({ accountId: f.accountId, strategyId: f.strategyId || null, symbol: f.symbol, segment: f.segment, exchange: f.exchange, qty: net, avg });
    }
  }
  return { closes, open };
}

/* ---------- filters ---------- */
const inDate = d => (!F.from || d >= F.from) && (!F.to || d <= F.to);
function passKeys(accountId, strategyId) {
  if (F.account && accountId !== F.account) return false;
  if (F.strategy === '__none') return !strategyId;
  if (F.strategy && strategyId !== F.strategy) return false;
  return true;
}
const passClose = (c, keys = true) => inDate(c.date) && (!F.segment || c.segment === F.segment) && (!keys || passKeys(c.accountId, c.strategyId));
const passAdj = (a, keys = true) => inDate(a.date) && !F.segment && (!keys || passKeys(a.accountId, a.strategyId || null));

function stats(closes, adjs) {
  let gross = 0, wins = 0, losses = 0, gw = 0, gl = 0, best = -Infinity, worst = Infinity;
  for (const c of closes) {
    gross += c.pnl;
    if (c.pnl > 0) { wins++; gw += c.pnl; } else if (c.pnl < 0) { losses++; gl -= c.pnl; }
    if (c.pnl > best) best = c.pnl;
    if (c.pnl < worst) worst = c.pnl;
  }
  const adj = adjs.reduce((s, a) => s + a.amount, 0), n = wins + losses;
  return {
    gross, adj, net: gross + adj, count: closes.length,
    winRate: n ? wins / n : null, pf: gl ? gw / gl : (gw ? Infinity : null),
    best: closes.length ? best : 0, worst: closes.length ? worst : 0,
  };
}

function setPreset(p) {
  const t = new Date(), fy = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1;
  if (p === 'all') { F.from = ''; F.to = ''; }
  if (p === 'fy') { F.from = `${fy}-04-01`; F.to = `${fy + 1}-03-31`; }
  if (p === 'lfy') { F.from = `${fy - 1}-04-01`; F.to = `${fy}-03-31`; }
  if (p === 'month') { F.from = ymd(new Date(t.getFullYear(), t.getMonth(), 1)); F.to = ''; }
  if (p === '30') { const d = new Date(t); d.setDate(d.getDate() - 30); F.from = ymd(d); F.to = ''; }
}

/* ---------- rendering ---------- */
function renderAll() {
  if (F.account && !S.accounts.some(a => a.id === F.account)) F.account = '';
  if (F.strategy && F.strategy !== '__none' && !strat(F.strategy)) F.strategy = '';
  renderFilters();
  const E = engine();
  renderOverview(E);
  renderTrades();
  renderSetup();
  renderImport();
  $('#subtitle').textContent = `${plural(S.accounts.length, 'account')}, ${plural(S.strategies.length, 'strategy')}, ${plural(S.trades.length, 'trade')}`;
}

function renderFilters() {
  $('#fAccount').innerHTML = opt('', 'All accounts', F.account) + S.accounts.map(a => opt(a.id, a.name, F.account)).join('');
  $('#fStrategy').innerHTML = opt('', 'All strategies', F.strategy) + S.strategies.map(s => opt(s.id, s.name, F.strategy)).join('') + opt('__none', 'Unassigned', F.strategy);
  const segs = [...new Set(S.trades.map(t => t.segment).filter(Boolean))].sort();
  $('#fSegment').innerHTML = opt('', 'All segments', F.segment) + segs.map(s => opt(s, s, F.segment)).join('');
  $('#fFrom').value = F.from;
  $('#fTo').value = F.to;
}

function renderOverview(E) {
  const empty = !S.trades.length && !S.adjustments.length;
  $('#overviewEmpty').hidden = !empty;
  $('#overviewBody').hidden = empty;
  if (empty) return;

  const closes = E.closes.filter(c => passClose(c));
  const adjs = S.adjustments.filter(a => passAdj(a));
  const st = stats(closes, adjs);

  const byDay = new Map();
  closes.forEach(c => byDay.set(c.date, (byDay.get(c.date) || 0) + c.pnl));
  adjs.forEach(a => byDay.set(a.date, (byDay.get(a.date) || 0) + a.amount));
  let cum = 0, peak = 0, dd = 0;
  [...byDay.keys()].sort().forEach(d => { cum += byDay.get(d); peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); });
  const days = new Set(closes.map(c => c.date)).size;
  const greenDays = [...new Set(closes.map(c => c.date))].filter(d => byDay.get(d) > 0).length;
  const open = E.open.filter(o => passKeys(o.accountId, o.strategyId) && (!F.segment || o.segment === F.segment));

  const scope = [F.account ? accName(F.account) : 'All accounts', F.strategy ? (F.strategy === '__none' ? 'Unassigned' : stratName(F.strategy)) : 'all strategies'].join(', ');
  $('#kpis').innerHTML = `
    <div class="kpi hero"><div class="l">Net P&amp;L</div><div class="v ${tone(st.net)}">${money(st.net)}</div><div class="s">${esc(scope)}</div></div>
    <div class="kpi"><div class="l">Realised</div><div class="v ${tone(st.gross)}">${money(st.gross)}</div><div class="s">before charges</div></div>
    <div class="kpi"><div class="l">Charges &amp; adj.</div><div class="v ${tone(st.adj)}">${money(st.adj)}</div><div class="s">${st.gross > 0 && st.adj < 0 ? pct(-st.adj / st.gross) + ' of realised' : '&nbsp;'}</div></div>
    <div class="kpi"><div class="l">Win rate</div><div class="v">${pct(st.winRate)}</div><div class="s">${plural(st.count, 'closed trade')}</div></div>
    <div class="kpi"><div class="l">Profit factor</div><div class="v">${ratio(st.pf)}</div><div class="s">gross wins ÷ losses</div></div>
    <div class="kpi"><div class="l">Max drawdown</div><div class="v ${dd > 0.5 ? 'neg' : ''}">${dd > 0.5 ? money(-dd) : '₹0'}</div><div class="s">peak to trough</div></div>
    <div class="kpi"><div class="l">Trading days</div><div class="v">${inr0.format(days)}</div><div class="s">${days ? pct(greenDays / days) + ' green' : '&nbsp;'}</div></div>`;

  renderCurve(closes, adjs);
  renderMatrix(E);
  renderMonthly(closes, adjs);
  renderBreakdown(closes, adjs);
  renderOpen(open);
}

function baseOpts(legend) {
  const ink = cssv('--muted'), line = cssv('--line');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position: 'bottom', labels: { color: ink, boxWidth: 10, boxHeight: 10 } },
      tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${money(ctx.parsed.y)}` } },
    },
    scales: {
      x: { ticks: { color: ink, maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
      y: { ticks: { color: ink, callback: v => '₹' + compact(v) }, grid: { color: line } },
    },
  };
}
function draw(id, cfg) {
  if (!window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), cfg);
}

function renderCurve(closes, adjs) {
  const keyFn = curveMode === 'account' ? x => x.accountId : curveMode === 'strategy' ? x => x.strategyId || '' : () => 'total';
  const nameFn = curveMode === 'account' ? accName : curveMode === 'strategy' ? k => stratName(k || null) : () => 'Net P&L';
  const colorFn = curveMode === 'account' ? accColor : curveMode === 'strategy' ? k => stratColor(k || null) : () => cssv('--accent');
  const series = new Map(), dates = new Set();
  const add = (k, d, v) => { if (!series.has(k)) series.set(k, new Map()); const m = series.get(k); m.set(d, (m.get(d) || 0) + v); dates.add(d); };
  closes.forEach(c => add(keyFn(c), c.date, c.pnl));
  adjs.forEach(a => add(keyFn(a), a.date, a.amount));
  const labels = [...dates].sort();
  const datasets = [...series].map(([k, m]) => {
    let c = 0; const col = colorFn(k);
    return { label: nameFn(k), data: labels.map(d => (c += m.get(d) || 0)), borderColor: col, backgroundColor: col, pointRadius: 0, borderWidth: 2, tension: 0.15 };
  });
  draw('curve', { type: 'line', data: { labels, datasets }, options: baseOpts(curveMode !== 'total') });
}

function renderMonthly(closes, adjs) {
  const m = new Map();
  closes.forEach(c => { const k = c.date.slice(0, 7); m.set(k, (m.get(k) || 0) + c.pnl); });
  adjs.forEach(a => { const k = a.date.slice(0, 7); m.set(k, (m.get(k) || 0) + a.amount); });
  const keys = [...m.keys()].sort();
  const fmt = k => new Date(k + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  const pos = cssv('--pos'), neg = cssv('--neg');
  const data = keys.map(k => m.get(k));
  const opts = baseOpts(false); opts.interaction = { mode: 'nearest', intersect: true };
  draw('monthly', { type: 'bar', data: { labels: keys.map(fmt), datasets: [{ label: 'Net', data, backgroundColor: data.map(v => v >= 0 ? pos : neg), borderRadius: 3 }] }, options: opts });
}

function renderMatrix(E) {
  const closes = E.closes.filter(c => passClose(c, false));
  const adjs = S.adjustments.filter(a => passAdj(a, false));
  const cell = new Map();
  const add = (a, s, v) => { const k = a + '|' + (s || ''); cell.set(k, (cell.get(k) || 0) + v); };
  closes.forEach(c => add(c.accountId, c.strategyId, c.pnl));
  adjs.forEach(a => add(a.accountId, a.strategyId, a.amount));

  const cols = S.strategies.map(s => ({ id: s.id, name: s.name, color: s.color }));
  if (S.accounts.some(a => cell.has(a.id + '|'))) cols.push({ id: '', name: 'Unassigned', color: '#8A94A3' });
  if (!S.accounts.length) { $('#matrix').innerHTML = '<p class="hint">Add accounts in Setup to see this breakdown.</p>'; return; }

  const max = Math.max(1, ...[...cell.values()].map(Math.abs));
  const pos = cssv('--pos'), neg = cssv('--neg');
  const bg = v => `color-mix(in srgb, ${v >= 0 ? pos : neg} ${Math.round(8 + 40 * Math.sqrt(Math.abs(v) / max))}%, transparent)`;
  const isSel = (a, s) => F.account === a && (s ? F.strategy === s : F.strategy === '__none');

  const colTot = cols.map(c => S.accounts.reduce((s, a) => s + (cell.get(a.id + '|' + c.id) || 0), 0));
  const body = S.accounts.map(a => {
    let tot = 0;
    const tds = cols.map(c => {
      const k = a.id + '|' + c.id;
      if (!cell.has(k)) return `<td class="cell"><button class="cellbtn empty" tabindex="-1" aria-disabled="true">–</button></td>`;
      const v = cell.get(k); tot += v;
      return `<td class="cell"><button class="cellbtn ${tone(v)} ${isSel(a.id, c.id) ? 'sel' : ''}" style="background:${bg(v)}" data-a="${esc(a.id)}" data-s="${esc(c.id)}" aria-label="${esc(a.name)}, ${esc(c.name)}: ${money(v)}">${money(v)}</button></td>`;
    }).join('');
    return `<tr><td class="l rowname">${esc(a.name)}${a.clientId ? `<small>${esc(a.clientId)}</small>` : ''}</td>${tds}<td class="tot ${tone(tot)}">${money(tot)}</td></tr>`;
  }).join('');
  const grand = colTot.reduce((s, v) => s + v, 0);
  $('#matrix').innerHTML = `<table class="matrix">
    <thead><tr><th class="l">Account</th>${cols.map(c => `<th><span class="swatch" style="background:${esc(c.color)}"></span>${esc(c.name)}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td class="l"><b>All accounts</b></td>${colTot.map(v => `<td class="tot ${tone(v)}">${money(v)}</td>`).join('')}<td class="tot ${tone(grand)}">${money(grand)}</td></tr></tfoot>
  </table>`;
}

function renderBreakdown(closes, adjs) {
  const key = breakdownBy === 'account' ? x => x.accountId : x => x.strategyId || '';
  const g = new Map();
  const get = k => { if (!g.has(k)) g.set(k, { c: [], a: [] }); return g.get(k); };
  closes.forEach(c => get(key(c)).c.push(c));
  adjs.forEach(a => get(key(a)).a.push(a));
  const rows = [...g].map(([k, v]) => ({ k, s: stats(v.c, v.a) })).sort((x, y) => y.s.net - x.s.net);
  if (!rows.length) { $('#breakdown').innerHTML = '<p class="hint">No closed trades in this period.</p>'; return; }
  const name = k => breakdownBy === 'account'
    ? `<span class="swatch" style="background:${accColor(k)}"></span>${esc(accName(k))}`
    : `<span class="swatch" style="background:${esc(stratColor(k || null))}"></span>${esc(stratName(k || null))}`;
  $('#breakdown').innerHTML = `<table><thead><tr>
    <th class="l">${breakdownBy === 'account' ? 'Account' : 'Strategy'}</th><th>Net</th><th>Realised</th><th>Charges</th><th>Closed</th><th>Win rate</th><th>Profit factor</th><th>Best</th><th>Worst</th>
  </tr></thead><tbody>${rows.map(({ k, s }) => `<tr>
    <td class="l">${name(k)}</td><td class="${tone(s.net)}"><b>${money(s.net)}</b></td><td class="${tone(s.gross)}">${money(s.gross)}</td>
    <td>${money(s.adj)}</td><td>${inr0.format(s.count)}</td><td>${pct(s.winRate)}</td><td>${ratio(s.pf)}</td>
    <td class="pos">${money(s.best)}</td><td class="neg">${money(s.worst)}</td></tr>`).join('')}</tbody></table>`;
}

function renderOpen(open) {
  openCache = open.sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!open.length) { $('#open').innerHTML = '<p class="hint">No open positions. Every buy has a matching sell.</p>'; return; }
  $('#open').innerHTML = `<table><thead><tr><th class="l">Account</th><th class="l">Strategy</th><th class="l">Symbol</th><th>Position</th><th>Avg price</th><th>Value</th><th></th></tr></thead>
  <tbody>${open.map((o, i) => `<tr>
    <td class="l">${esc(accName(o.accountId))}</td><td class="l">${esc(stratName(o.strategyId))}</td>
    <td class="l">${esc(o.symbol)}<small>${esc(o.segment)}</small></td>
    <td class="${o.qty > 0 ? 'buy' : 'sell'}">${o.qty > 0 ? 'Long' : 'Short'} ${inr0.format(Math.abs(o.qty))}</td>
    <td>${inr2.format(o.avg)}</td><td>₹${inr0.format(Math.abs(o.qty * o.avg))}</td>
    <td><button class="btn small" data-settle="${i}">Settle</button></td></tr>`).join('')}</tbody></table>`;
}

function filteredTrades() {
  const q = search.trim().toUpperCase();
  return S.trades.filter(t => inDate(t.date) && (!F.segment || t.segment === F.segment) && passKeys(t.accountId, t.strategyId || null) && (!q || t.symbol.includes(q)))
    .sort((a, b) => a.time < b.time ? 1 : a.time > b.time ? -1 : 0);
}
const stratOpts = (sel, blankLabel = 'Unassigned') => opt('', blankLabel, sel || '') + S.strategies.map(s => opt(s.id, s.name, sel || '')).join('');
const accOpts = (sel, blankLabel) => (blankLabel ? opt('', blankLabel, sel || '') : '') + S.accounts.map(a => opt(a.id, a.name, sel || '')).join('');

function renderTrades() {
  const list = filteredTrades();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (page >= pages) page = pages - 1;
  const rows = list.slice(page * PAGE, (page + 1) * PAGE);
  pageIds = rows.map(r => r.id);
  for (const id of selected) if (!S.trades.some(t => t.id === id)) selected.delete(id);

  $('#tradeCount').textContent = `${plural(list.length, 'trade')} match the filters${selected.size ? `, ${inr0.format(selected.size)} selected` : ''}.`;
  const allOnPage = rows.length && rows.every(r => selected.has(r.id));
  $('#tradesTable').innerHTML = !rows.length
    ? '<tbody><tr><td class="l muted">No trades match. Import a tradebook or change the filters.</td></tr></tbody>'
    : `<thead><tr><th class="l"><input type="checkbox" id="selectPage" aria-label="Select this page" ${allOnPage ? 'checked' : ''}></th>
      <th class="l">Date</th><th class="l">Account</th><th class="l">Symbol</th><th class="l">Side</th><th>Qty</th><th>Price</th><th>Value</th><th class="l">Strategy</th></tr></thead>
      <tbody>${rows.map(t => `<tr>
        <td class="l"><input type="checkbox" data-sel="${t.id}" ${selected.has(t.id) ? 'checked' : ''} aria-label="Select trade"></td>
        <td class="l">${esc(t.date)}<small>${esc(t.time.slice(11, 16))}</small></td>
        <td class="l">${esc(accName(t.accountId))}</td>
        <td class="l">${esc(t.symbol)}<small>${esc(t.segment)}</small></td>
        <td class="l ${t.side}">${t.side === 'buy' ? 'Buy' : 'Sell'}</td>
        <td>${inr0.format(t.qty)}</td><td>${inr2.format(t.price)}</td><td>₹${inr0.format(t.qty * t.price)}</td>
        <td class="l"><select data-strat="${t.id}" aria-label="Strategy">${stratOpts(t.strategyId)}</select></td></tr>`).join('')}</tbody>`;
  $('#pager').innerHTML = pages > 1
    ? `<button class="btn small" data-page="-1" ${page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${page + 1} of ${pages}</span><button class="btn small" data-page="1" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>`
    : '';
  $('#bulkStrategy').innerHTML = stratOpts('');
  $('#mAccount').innerHTML = accOpts($('#mAccount').value || F.account);
  $('#mStrategy').innerHTML = stratOpts($('#mStrategy').value || '');
  if (!$('#mDate').value) $('#mDate').value = ymd(new Date());
}

function renderSetup() {
  const cnt = new Map();
  S.trades.forEach(t => { cnt.set(t.accountId, (cnt.get(t.accountId) || 0) + 1); cnt.set('s:' + (t.strategyId || ''), (cnt.get('s:' + (t.strategyId || '')) || 0) + 1); });

  $('#accountsList').innerHTML = S.accounts.length ? `<table><thead><tr><th class="l">Name</th><th class="l">Client ID</th><th>Trades</th><th></th></tr></thead><tbody>${S.accounts.map(a => `<tr>
    <td class="l"><span class="swatch" style="background:${accColor(a.id)}"></span>${esc(a.name)}</td><td class="l">${esc(a.clientId)}</td><td>${inr0.format(cnt.get(a.id) || 0)}</td>
    <td><button class="btn small danger" data-del-acc="${a.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No accounts yet.</p>';

  $('#strategiesList').innerHTML = S.strategies.length ? `<table><thead><tr><th class="l">Name</th><th>Trades</th><th></th></tr></thead><tbody>${S.strategies.map(s => `<tr>
    <td class="l"><span class="swatch" style="background:${esc(s.color)}"></span>${esc(s.name)}</td><td>${inr0.format(cnt.get('s:' + s.id) || 0)}</td>
    <td><button class="btn small danger" data-del-strat="${s.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No strategies yet.</p>';

  $('#rulesList').innerHTML = S.rules.length ? `<table><thead><tr><th class="l">Order</th><th class="l">Pattern</th><th class="l">Account</th><th class="l">Strategy</th><th></th></tr></thead><tbody>${S.rules.map((r, i) => `<tr>
    <td class="l">${i + 1}</td><td class="l"><b>${esc(r.pattern)}</b></td><td class="l">${r.accountId ? esc(accName(r.accountId)) : 'Any account'}</td><td class="l">${esc(stratName(r.strategyId))}</td>
    <td><button class="btn small danger" data-del-rule="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No rules yet. Without rules, imported trades start as Unassigned and you can tag them on the Trades tab.</p>';

  const adj = [...S.adjustments].sort((a, b) => b.date.localeCompare(a.date));
  $('#adjList').innerHTML = adj.length ? `<table><thead><tr><th class="l">Date</th><th class="l">Account</th><th class="l">Strategy</th><th>Amount</th><th class="l">Note</th><th></th></tr></thead><tbody>${adj.map(a => `<tr>
    <td class="l">${esc(a.date)}</td><td class="l">${esc(accName(a.accountId))}</td><td class="l">${esc(stratName(a.strategyId))}</td>
    <td class="${tone(a.amount)}">${money(a.amount)}</td><td class="l">${esc(a.note)}</td>
    <td><button class="btn small danger" data-del-adj="${a.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No entries yet.</p>';

  $('#rAccount').innerHTML = accOpts($('#rAccount').value, 'Any account');
  $('#rStrategy').innerHTML = S.strategies.map(s => opt(s.id, s.name, $('#rStrategy').value)).join('');
  $('#jAccount').innerHTML = accOpts($('#jAccount').value);
  $('#jStrategy').innerHTML = stratOpts($('#jStrategy').value, 'No specific strategy');
  if (!$('#jDate').value) $('#jDate').value = ymd(new Date());
}

function renderImport() {
  $('#iAccount').innerHTML = S.accounts.length ? accOpts($('#iAccount').value) : opt('', 'Add an account in Setup first', '');
  $('#iStrategy').innerHTML = stratOpts($('#iStrategy').value, 'Use auto-tagging rules');
}

/* ---------- actions ---------- */
function settle(o) {
  const p = prompt(`Closing price for ${o.symbol}. Use 0 for options that expired worthless.`, '0');
  if (p === null) return;
  const price = parseFloat(p);
  if (isNaN(price) || price < 0) { toast('Enter a price of 0 or more.'); return; }
  const d = prompt('Date of the closing trade, as YYYY-MM-DD (the expiry date for expired contracts).', ymd(new Date()));
  if (d === null) return;
  const date = parseDate(d);
  if (!date) { toast('Use the date format YYYY-MM-DD.'); return; }
  S.trades.push({
    id: uid(), accountId: o.accountId, strategyId: o.strategyId, symbol: o.symbol, segment: o.segment, exchange: o.exchange || '',
    date, time: date + 'T23:59:59', side: o.qty > 0 ? 'sell' : 'buy', qty: Math.abs(o.qty), price, tradeId: 'manual-' + uid(), orderId: '', manual: true,
  });
  save(); renderAll(); toast(`Settled ${o.symbol}.`);
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trade-ledger-backup-${ymd(new Date())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup exported.');
}
async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.trades) || !Array.isArray(d.accounts)) throw new Error('shape');
    if (!confirm(`Replace current data with this backup (${plural(d.trades.length, 'trade')})?`)) return;
    S = Object.assign(blank(), d); save(); renderAll(); toast('Backup imported.');
  } catch (e) { toast('That file is not a Trade ledger backup.'); }
}

function loadDemo() {
  if ((S.trades.length || S.accounts.length) && !confirm('Replace your current data with demo data? Export a backup first if you want to keep it.')) return;
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const a1 = { id: uid(), name: 'Self', clientId: 'AB1234' }, a2 = { id: uid(), name: 'Family HUF', clientId: 'CD5678' };
  const st = [
    { id: uid(), name: 'Nifty short straddle', color: PALETTE[0] },
    { id: uid(), name: 'BankNifty momentum', color: PALETTE[1] },
    { id: uid(), name: 'Swing equity', color: PALETTE[2] },
  ];
  const trades = [], days = [], t0 = new Date();
  for (let i = 200; i > 0; i--) { const d = new Date(t0); d.setDate(d.getDate() - i); if (d.getDay() % 6) days.push(ymd(d)); }
  const push = (acc, s, sym, seg, ex, date, time, side, qty, price) => trades.push({
    id: uid(), accountId: acc.id, strategyId: s ? s.id : null, symbol: sym, segment: seg, exchange: ex, date, time: `${date}T${time}`,
    side, qty, price: Math.round(price * 20) / 20, tradeId: 'DEMO' + trades.length, orderId: '',
  });
  days.forEach((d, i) => {
    for (const acc of [a1, a2]) {
      if (rnd() < 0.7) {
        const strike = 23000 + Math.round(rnd() * 20) * 50, lot = acc === a1 ? 75 : 150;
        for (const k of ['CE', 'PE']) {
          const p = 80 + rnd() * 80, sym = `NIFTY${strike}${k}`;
          push(acc, st[0], sym, 'FO', 'NFO', d, '09:20:00', 'sell', lot, p);
          push(acc, st[0], sym, 'FO', 'NFO', d, '15:10:00', 'buy', lot, p * (0.55 + rnd() * 0.8));
        }
      }
    }
    if (rnd() < 0.45) {
      const p = 200 + rnd() * 200, sym = `BANKNIFTY${50000 + Math.round(rnd() * 30) * 100}${rnd() < 0.5 ? 'CE' : 'PE'}`;
      const s = rnd() < 0.85 ? st[1] : null; // a few left untagged to show the Unassigned column
      push(a1, s, sym, 'FO', 'NFO', d, '10:05:00', 'buy', 30, p);
      push(a1, s, sym, 'FO', 'NFO', d, '13:40:00', 'sell', 30, p * (0.7 + rnd() * 0.66));
    }
    if (i % 8 === 0 && i + 6 < days.length) {
      const syms = ['INFY', 'TCS', 'HDFCBANK', 'RELIANCE', 'ITC', 'LT'], sym = syms[Math.floor(rnd() * syms.length)];
      const acc = rnd() < 0.5 ? a1 : a2, p = 500 + rnd() * 2500, q = Math.max(1, Math.round(100000 / p));
      push(acc, st[2], sym, 'EQ', 'NSE', d, '11:00:00', 'buy', q, p);
      push(acc, st[2], sym, 'EQ', 'NSE', days[i + 6], '14:00:00', 'sell', q, p * (0.94 + rnd() * 0.14));
    }
  });
  push(a2, st[2], 'TATAMOTORS', 'EQ', 'NSE', days[days.length - 3], '10:30:00', 'buy', 100, 742.5);
  const adjustments = [];
  [...new Set(days.map(d => d.slice(0, 7)))].forEach(m => {
    const last = days.filter(d => d.startsWith(m)).pop();
    const add = (acc, s, base) => adjustments.push({ id: uid(), date: last, accountId: acc.id, strategyId: s.id, amount: -Math.round(base * (0.8 + rnd() * 0.4)), note: `${m} charges` });
    add(a1, st[0], 5200); add(a1, st[1], 1800); add(a1, st[2], 300);
    add(a2, st[0], 7400); add(a2, st[2], 300);
  });
  S = { accounts: [a1, a2], strategies: st, rules: [{ id: uid(), pattern: 'BANKNIFTY*', accountId: '', strategyId: st[1].id }], adjustments, trades };
  Object.assign(F, { account: '', strategy: '', segment: '', from: '', to: '' });
  $('#fPreset').value = '';
  save(); renderAll(); showTab('overview'); toast('Demo data loaded. Delete it from Setup when you are ready to use your own.');
}

/* ---------- events ---------- */
function showTab(name) {
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  $('#filters').hidden = !(name === 'overview' || name === 'trades');
}

function bind() {
  $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-goto]'); if (g) showTab(g.dataset.goto);
    if (e.target.closest('[data-action="demo"]')) loadDemo();
  });

  const onFilter = () => { page = 0; renderAll(); };
  $('#fAccount').addEventListener('change', e => { F.account = e.target.value; onFilter(); });
  $('#fStrategy').addEventListener('change', e => { F.strategy = e.target.value; onFilter(); });
  $('#fSegment').addEventListener('change', e => { F.segment = e.target.value; onFilter(); });
  $('#fFrom').addEventListener('change', e => { F.from = e.target.value; $('#fPreset').value = ''; onFilter(); });
  $('#fTo').addEventListener('change', e => { F.to = e.target.value; $('#fPreset').value = ''; onFilter(); });
  $('#fPreset').addEventListener('change', e => { setPreset(e.target.value); onFilter(); });
  $('#fClear').addEventListener('click', () => { Object.assign(F, { account: '', strategy: '', segment: '', from: '', to: '' }); $('#fPreset').value = ''; onFilter(); });

  $('#curveMode').addEventListener('change', e => { curveMode = e.target.value; renderAll(); });
  $$('[data-bd]').forEach(b => b.addEventListener('click', () => {
    breakdownBy = b.dataset.bd;
    $$('[data-bd]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderAll();
  }));
  $('#matrix').addEventListener('click', e => {
    const b = e.target.closest('.cellbtn[data-a]'); if (!b) return;
    const s = b.dataset.s || '__none';
    if (F.account === b.dataset.a && F.strategy === s) { F.account = ''; F.strategy = ''; }
    else { F.account = b.dataset.a; F.strategy = s; }
    onFilter();
  });
  $('#open').addEventListener('click', e => { const b = e.target.closest('[data-settle]'); if (b) settle(openCache[+b.dataset.settle]); });

  // trades table
  $('#tSearch').addEventListener('input', e => { search = e.target.value; page = 0; renderTrades(); });
  $('#tradesTable').addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'selectPage') { pageIds.forEach(id => t.checked ? selected.add(id) : selected.delete(id)); renderTrades(); return; }
    if (t.dataset.sel) { t.checked ? selected.add(t.dataset.sel) : selected.delete(t.dataset.sel); renderTrades(); return; }
    if (t.dataset.strat) {
      const tr = S.trades.find(x => x.id === t.dataset.strat);
      if (tr) { tr.strategyId = t.value || null; save(); renderAll(); toast(`Tagged ${tr.symbol} as ${stratName(tr.strategyId)}.`); }
    }
  });
  $('#pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) { page += +b.dataset.page; renderTrades(); } });
  $('#selectAll').addEventListener('click', () => { filteredTrades().forEach(t => selected.add(t.id)); renderTrades(); });
  $('#selectNone').addEventListener('click', () => { selected.clear(); renderTrades(); });
  $('#bulkApply').addEventListener('click', () => {
    if (!selected.size) { toast('Select trades first.'); return; }
    const sid = $('#bulkStrategy').value || null, n = selected.size;
    S.trades.forEach(t => { if (selected.has(t.id)) t.strategyId = sid; });
    selected.clear(); save(); renderAll(); toast(`Tagged ${plural(n, 'trade')} as ${stratName(sid)}.`);
  });
  $('#bulkDelete').addEventListener('click', () => {
    if (!selected.size) { toast('Select trades first.'); return; }
    if (!confirm(`Delete ${plural(selected.size, 'trade')}? This cannot be undone.`)) return;
    const n = selected.size;
    S.trades = S.trades.filter(t => !selected.has(t.id)); selected.clear(); save(); renderAll(); toast(`Deleted ${plural(n, 'trade')}.`);
  });
  $('#mAdd').addEventListener('click', () => {
    const accountId = $('#mAccount').value, symbol = $('#mSymbol').value.trim().toUpperCase(), date = $('#mDate').value;
    const qty = parseFloat($('#mQty').value), price = parseFloat($('#mPrice').value);
    if (!accountId) { toast('Add an account in Setup first.'); return; }
    if (!symbol || !date || !(qty > 0) || !(price >= 0)) { toast('Fill in symbol, date, quantity and price.'); return; }
    const time = ($('#mTime').value || '09:15:00').padEnd(8, ':00').slice(0, 8);
    S.trades.push({ id: uid(), accountId, strategyId: $('#mStrategy').value || null, symbol, segment: $('#mSegment').value, exchange: '', date, time: `${date}T${time}`, side: $('#mSide').value, qty, price, tradeId: 'manual-' + uid(), orderId: '', manual: true });
    $('#mSymbol').value = ''; $('#mQty').value = ''; $('#mPrice').value = '';
    save(); renderAll(); toast(`Added ${symbol}.`);
  });

  // import
  $('#iRun').addEventListener('click', doImport);

  // setup
  $('#aAdd').addEventListener('click', () => {
    const name = $('#aName').value.trim(); if (!name) { toast('Give the account a name.'); return; }
    S.accounts.push({ id: uid(), name, clientId: $('#aClient').value.trim().toUpperCase() });
    $('#aName').value = ''; $('#aClient').value = ''; save(); renderAll(); toast(`Added ${name}.`);
  });
  $('#sAdd').addEventListener('click', () => {
    const name = $('#sName').value.trim(); if (!name) { toast('Give the strategy a name.'); return; }
    S.strategies.push({ id: uid(), name, color: $('#sColor').value });
    $('#sName').value = ''; $('#sColor').value = PALETTE[S.strategies.length % PALETTE.length]; save(); renderAll(); toast(`Added ${name}.`);
  });
  $('#rAdd').addEventListener('click', () => {
    const pattern = $('#rPattern').value.trim(), strategyId = $('#rStrategy').value;
    if (!pattern) { toast('Enter a symbol pattern.'); return; }
    if (!strategyId) { toast('Add a strategy first.'); return; }
    S.rules.push({ id: uid(), pattern, accountId: $('#rAccount').value, strategyId });
    $('#rPattern').value = ''; save(); renderAll(); toast('Rule added.');
  });
  $('#rApply').addEventListener('click', () => {
    let n = 0;
    S.trades.forEach(t => { if (!t.strategyId) { const s = applyRules(t.symbol, t.accountId); if (s) { t.strategyId = s; n++; } } });
    save(); renderAll(); toast(n ? `Tagged ${plural(n, 'trade')}.` : 'No unassigned trades matched a rule.');
  });
  $('#jAdd').addEventListener('click', () => {
    const accountId = $('#jAccount').value, amount = parseFloat($('#jAmount').value), date = $('#jDate').value;
    if (!accountId) { toast('Add an account first.'); return; }
    if (!date || isNaN(amount)) { toast('Enter a date and an amount. Use a negative amount for charges.'); return; }
    S.adjustments.push({ id: uid(), date, accountId, strategyId: $('#jStrategy').value || null, amount, note: $('#jNote').value.trim() });
    $('#jAmount').value = ''; $('#jNote').value = ''; save(); renderAll(); toast('Entry added.');
  });
  $('#tab-setup').addEventListener('click', e => {
    const d = e.target.closest('button'); if (!d) return;
    if (d.dataset.delAcc) {
      const id = d.dataset.delAcc, n = S.trades.filter(t => t.accountId === id).length;
      if (!confirm(`Delete ${accName(id)}${n ? ` and its ${plural(n, 'trade')}` : ''}?`)) return;
      S.accounts = S.accounts.filter(a => a.id !== id);
      S.trades = S.trades.filter(t => t.accountId !== id);
      S.adjustments = S.adjustments.filter(a => a.accountId !== id);
      S.rules = S.rules.filter(r => r.accountId !== id);
    } else if (d.dataset.delStrat) {
      const id = d.dataset.delStrat;
      if (!confirm(`Delete ${stratName(id)}? Its trades become Unassigned.`)) return;
      S.strategies = S.strategies.filter(s => s.id !== id);
      S.trades.forEach(t => { if (t.strategyId === id) t.strategyId = null; });
      S.adjustments.forEach(a => { if (a.strategyId === id) a.strategyId = null; });
      S.rules = S.rules.filter(r => r.strategyId !== id);
    } else if (d.dataset.delRule) S.rules = S.rules.filter(r => r.id !== d.dataset.delRule);
    else if (d.dataset.delAdj) S.adjustments = S.adjustments.filter(a => a.id !== d.dataset.delAdj);
    else return;
    save(); renderAll();
  });
  $('#bExport').addEventListener('click', exportBackup);
  $('#bImport').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
  $('#bReset').addEventListener('click', () => {
    if (!confirm('Delete all accounts, strategies, trades and entries from this browser? Export a backup first if you want to keep them.')) return;
    S = blank(); save(); renderAll(); toast('All data deleted.');
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderAll);
}

bind();
renderAll();
if (!window.Chart) toast('Charts could not load. Check your connection; tables still work.');
})();
