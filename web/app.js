/* UI: controls, summary, charts (hand-built SVG) and the strike table. */
(function () {
  'use strict';
  const M = window.Model;
  const DAY = M.DAY;
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');

  const state = {
    data: null, expiries: [], expiry: null, side: 'C', range: 0.5, settle: null,
    v2: { lookback: 4, halfLife: 365, vol: 'ewma', drift: 'zero' },
  };

  // ---------- formatting ----------
  const fmtUsd = x => !isFinite(x) || x === 0 ? '–' : '$' + x.toLocaleString('en-US', Math.abs(x) >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (x, d = 1) => !isFinite(x) ? '–' : (x * 100).toFixed(d) + '%';
  const fmtDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const fmtDays = d => d < 1 ? (d * 24).toFixed(1) + ' h' : d.toFixed(d < 10 ? 1 : 0) + ' d';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- model wiring ----------
  function prepare(data) {
    const candles = M.completedCandles(data.candles, data.now);
    const vol = M.ewmaVol(candles, 0.94);
    const volLR = M.longRunVol(candles);
    const settles = [...new Set(data.options.map(o => o.settle))];
    return Object.assign(data, { candles, vol, volLR, settles, spot: candles[candles.length - 1].c });
  }

  function groupExpiries(data, settle) {
    const by = new Map();
    for (const o of data.options) {
      if (o.settle !== settle || o.expiry <= data.now) continue;
      if (!by.has(o.expiry)) by.set(o.expiry, []);
      by.get(o.expiry).push(o);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([expiry, opts]) => {
      const F = median(opts.map(o => o.underlying).filter(x => x > 0)) || data.spot;
      const S = median(opts.map(o => o.index).filter(x => x > 0)) || data.spot;
      return { expiry, opts, F, S, days: (expiry - data.now) / DAY };
    });
  }

  function median(xs) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; }

  // ATM implied vol: average call/put mark IV interpolated at the forward.
  function atmIv(ex) {
    const byK = new Map();
    for (const o of ex.opts) if (o.iv > 0) { const a = byK.get(o.strike) || []; a.push(o.iv); byK.set(o.strike, a); }
    const pts = [...byK.entries()].map(([k, a]) => [k, a.reduce((x, y) => x + y, 0) / a.length]).sort((a, b) => a[0] - b[0]);
    if (!pts.length) return 0;
    return interp(pts, ex.F);
  }

  function interp(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return pts[pts.length - 1][1];
  }

  function models(ex) {
    if (ex._models && ex._key === JSON.stringify(state.v2)) return ex._models;
    const d = state.data, c = d.candles, last = c.length - 1;
    const n = Math.max(1, Math.round(ex.days));
    const iv = atmIv(ex);

    // V1: all history, equal weights, raw returns (drift included), centred on spot.
    const v1 = M.buildSamples(c, n, {});

    // V2: chosen lookback, recency weights, vol-regime scaling, drift choice.
    let startIdx = 0, extended = false;
    if (state.v2.lookback > 0) {
      const from = d.now - state.v2.lookback * 365 * DAY;
      startIdx = c.findIndex(k => k.t >= from);
      if (startIdx < 0) startIdx = 0;
      const minSamples = 60;
      if (last - n - startIdx < minSamples) { startIdx = Math.max(0, last - n - minSamples); extended = true; }
    }
    let targetVol = null;
    if (state.v2.vol === 'ewma') targetVol = M.horizonVol(d.vol[last], d.volLR, n);
    else if (state.v2.vol === 'iv' && iv > 0) targetVol = iv / Math.sqrt(365);
    const v2 = M.buildSamples(c, n, {
      startIdx, targetVol, volArr: d.vol, volLR: d.volLR,
      timeScale: Math.sqrt(Math.max(ex.days, 0.05) / n),
      halfLife: state.v2.halfLife, demean: state.v2.drift === 'zero',
    });
    const v2Center = state.v2.drift === 'zero' ? ex.F : ex.S;
    ex._key = JSON.stringify(state.v2);
    ex._models = { n, iv, v1, v2, v1Center: ex.S, v2Center, extended };
    return ex._models;
  }

  function rows(ex) {
    const md = models(ex);
    const T = ex.days / 365;
    const isCall = state.side === 'C';
    const lo = ex.F * (1 - state.range), hi = ex.F * (1 + state.range);
    return ex.opts
      .filter(o => o.side === state.side && (state.range >= 9 || (o.strike >= lo && o.strike <= hi)))
      .sort((a, b) => a.strike - b.strike)
      .map(o => {
        const e1 = M.evaluate(md.v1, md.v1Center, o.strike);
        const e2 = M.evaluate(md.v2, md.v2Center, o.strike);
        const pMktAbove = o.iv > 0 ? M.impliedProbAbove(ex.F, o.strike, T, o.iv) : NaN;
        const itm = p => isCall ? p : 1 - p;
        return {
          o, moneyness: o.strike / ex.F - 1,
          pMkt: itm(pMktAbove), p1: itm(e1.pAbove), p2: itm(e2.pAbove),
          t1: e1.pTouch, t2: e2.pTouch,
          f1: isCall ? e1.callFair : e1.putFair,
          f2: isCall ? e2.callFair : e2.putFair,
        };
      });
  }

  // Edge vs what you would actually pay / receive: buy at ask, sell at bid.
  function signal(fair, o) {
    if (o.ask > 0 && fair > o.ask) return { kind: 'buy', amt: fair - o.ask, pct: (fair - o.ask) / o.ask };
    if (o.bid > 0 && fair < o.bid) return { kind: 'sell', amt: o.bid - fair, pct: (o.bid - fair) / o.bid };
    return null;
  }

  // ---------- rendering ----------
  function render() {
    const ex = state.expiries.find(e => e.expiry === state.expiry);
    if (!ex) return;
    const md = models(ex);
    const r = rows(ex);
    renderSummary(ex, md);
    renderProbChart(ex, md);
    renderVolChart();
    renderTable(ex, r, md);
  }

  function renderSummary(ex, md) {
    const tiles = [
      ['Time to expiry', fmtDays(ex.days), fmtDate(ex.expiry) + ' 08:00 UTC'],
      ['Forward', fmtUsd(ex.F), 'spot ' + fmtUsd(ex.S)],
      ['ATM implied vol', fmtPct(md.iv), 'what the market prices'],
      ['V1 historical vol', fmtPct(md.v1.annualVol), fmtNum(md.v1.count) + ' windows · ~' + fmtNum(md.v1.effective) + ' independent'],
      ['V2 adjusted vol', fmtPct(md.v2.annualVol), fmtNum(md.v2.count) + ' windows · ~' + fmtNum(md.v2.effective) + ' independent' + (md.extended ? ' · lookback extended' : '')],
    ];
    $('#summary').innerHTML = tiles.map(([k, v, s]) =>
      `<div class="tile"><div class="tile-k">${k}</div><div class="tile-v">${v}</div><div class="tile-s">${s}</div></div>`).join('');
    const warn = [];
    if (md.v1.effective < 8) warn.push(`Only ~${fmtNum(md.v1.effective)} independent ${md.n}-day periods exist in history, so long-dated probabilities are rough.`);
    if (md.n === 1 && ex.days < 1) warn.push('Under a day to expiry: daily bars are coarse here. V2 shrinks returns by √time to compensate; V1 uses a full day.');
    $('#warn').innerHTML = warn.map(w => `<p>${w}</p>`).join('');
  }
  const fmtNum = x => Math.round(x).toLocaleString('en-US');

  // Line chart helper: series [{key, label, cls, pts:[[x,y]], dots?}]
  function lineChart(el, { series, xFmt, yFmt, yMax, xMarker, xLabel, xTicks }) {
    const W = el.clientWidth || 640, H = Math.max(220, Math.min(320, W * 0.5));
    const m = { l: 44, r: 12, t: 10, b: 30 };
    const all = series.flatMap(s => s.pts);
    if (!all.length) { el.innerHTML = ''; return; }
    const xMin = Math.min(...all.map(p => p[0])), xMax = Math.max(...all.map(p => p[0]));
    let yTop = yMax || Math.max(...all.map(p => p[1])) * 1.1 || 1;
    if (!yMax) { const t = ticks(0, yTop, 4); const st = t[1] - t[0]; yTop = Math.ceil(yTop / st - 1e-9) * st; }
    const X = x => m.l + (x - xMin) / ((xMax - xMin) || 1) * (W - m.l - m.r);
    const Y = y => H - m.b - y / yTop * (H - m.t - m.b);
    const yt = yMax ? [0, 0.25, 0.5, 0.75, 1].map(f => f * yTop) : ticks(0, yTop, 4);
    const xt = xTicks || ticks(xMin, xMax, Math.max(3, Math.floor(W / 110)));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    for (const y of yt) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}"/><text class="tick" x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end">${yFmt(y)}</text>`;
    svg += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    for (const x of xt) svg += `<text class="tick" x="${X(x)}" y="${H - m.b + 18}" text-anchor="middle">${xFmt(x)}</text>`;
    if (xMarker != null && xMarker >= xMin && xMarker <= xMax) {
      svg += `<line class="marker" x1="${X(xMarker)}" x2="${X(xMarker)}" y1="${m.t}" y2="${H - m.b}"/><text class="tick" x="${X(xMarker) + 4}" y="${m.t + 10}">${xLabel}</text>`;
    }
    for (const s of series) {
      if (!s.pts.length) continue;
      svg += `<path class="line ${s.cls}${s.dash ? ' dash' : ''}" d="${s.pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join('')}"/>`;
      if (s.dots) for (const p of s.pts) svg += `<circle class="dot ${s.cls}" cx="${X(p[0])}" cy="${Y(p[1])}" r="4"/>`;
    }
    svg += `<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" style="display:none"/>`;
    svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></svg>`;
    el.innerHTML = svg + '<div class="tip" hidden></div>';
    const svgEl = el.querySelector('svg'), cross = el.querySelector('.cross'), tip = el.querySelector('.tip');
    const move = ev => {
      const rect = svgEl.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * W / rect.width;
      const x = xMin + (px - m.l) / (W - m.l - m.r) * (xMax - xMin);
      const snap = series.find(s => s.snap);
      const xs = snap ? snap.pts.map(p => p[0]).reduce((a, b) => Math.abs(b - x) < Math.abs(a - x) ? b : a) : x;
      cross.setAttribute('x1', X(xs)); cross.setAttribute('x2', X(xs)); cross.style.display = '';
      tip.innerHTML = `<div class="tip-h">${xFmt(xs, true)}</div>` + series.filter(s => s.pts.length).map(s =>
        `<div><span class="key ${s.cls}"></span>${s.label}<b>${yFmt(interp(s.pts, xs), true)}</b></div>`).join('');
      tip.hidden = false;
      const left = Math.min(X(xs) * rect.width / W + 12, rect.width - tip.offsetWidth - 4);
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = '8px';
    };
    svgEl.addEventListener('pointermove', move);
    svgEl.addEventListener('pointerdown', move);
    svgEl.addEventListener('pointerleave', () => { cross.style.display = 'none'; tip.hidden = true; });
  }

  function ticks(a, b, n) {
    const span = b - a, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || mag * 10;
    const out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(v);
    return out;
  }

  function renderProbChart(ex, md) {
    const T = ex.days / 365;
    const strikes = [...new Set(ex.opts.filter(o => o.iv > 0).map(o => o.strike))].sort((a, b) => a - b);
    const lo = state.range >= 9 ? strikes[0] : Math.max(strikes[0], ex.F * (1 - state.range));
    const hi = state.range >= 9 ? strikes[strikes.length - 1] : Math.min(strikes[strikes.length - 1], ex.F * (1 + state.range));
    const xs = []; for (let k = 0; k <= 160; k++) xs.push(lo + (hi - lo) * k / 160);
    const s1 = M.survivalCurve(md.v1, md.v1Center, xs), s2 = M.survivalCurve(md.v2, md.v2Center, xs);
    const ivAt = new Map();
    for (const o of ex.opts) if (o.iv > 0 && o.side === (o.strike >= ex.F ? 'C' : 'P')) ivAt.set(o.strike, o.iv); // OTM side
    for (const o of ex.opts) if (o.iv > 0 && !ivAt.has(o.strike)) ivAt.set(o.strike, o.iv);
    const mkt = strikes.filter(k => k >= lo && k <= hi).map(k => [k, M.impliedProbAbove(ex.F, k, T, ivAt.get(k))]);
    $('#prob-title').textContent = `Chance BTC finishes above each price on ${fmtDate(ex.expiry)}`;
    lineChart($('#prob-chart'), {
      series: [
        { label: 'V1 history', cls: 's1', pts: xs.map((x, i) => [x, s1[i]]) },
        { label: 'V2 adjusted', cls: 's2', pts: xs.map((x, i) => [x, s2[i]]) },
        { label: 'Market (IV)', cls: 's3', pts: mkt, dots: true, dash: true },
      ],
      xFmt: (x, full) => full ? fmtUsd(x) : '$' + (x / 1000).toFixed(x >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k',
      yFmt: (y, full) => fmtPct(y, full ? 1 : 0), yMax: 1, xMarker: ex.F, xLabel: 'forward',
    });
  }

  function renderVolChart() {
    const pts = state.expiries.map(ex => ({ ex, md: models(ex) }));
    const x = p => Math.log(Math.max(p.ex.days, 0.1));
    const series = [
      { label: 'V1 history', cls: 's1', pts: pts.map(p => [x(p), p.md.v1.annualVol]), dots: true, snap: true },
      { label: 'V2 adjusted', cls: 's2', pts: pts.map(p => [x(p), p.md.v2.annualVol]), dots: true },
      { label: 'Market ATM IV', cls: 's3', pts: pts.filter(p => p.md.iv > 0).map(p => [x(p), p.md.iv]), dots: true, dash: true },
    ];
    const dayTicks = [1, 7, 30, 90, 180, 365].filter(d => Math.log(d) >= x(pts[0]) - 0.2 && Math.log(d) <= x(pts[pts.length - 1]) + 0.2).map(Math.log);
    lineChart($('#vol-chart'), {
      series, yFmt: (y, full) => fmtPct(y, full ? 1 : 0), xTicks: dayTicks,
      xFmt: (v, full) => { const d = Math.exp(v); if (!full) return d >= 360 ? '1y' : Math.round(d) + 'd'; const p = pts.find(q => Math.abs(x(q) - v) < 1e-9); return p ? fmtDate(p.ex.expiry) + ' · ' + fmtDays(p.ex.days) : fmtDays(d); },
    });
  }

  function renderTable(ex, r, md) {
    const isCall = state.side === 'C';
    const head = `<tr><th class="sticky">Strike</th><th>vs fwd</th><th>Bid</th><th>Mark</th><th>Ask</th><th>IV</th>
      <th class="g">P(ITM) Mkt</th><th>V1</th><th>V2</th><th class="g">P(touch) V1</th><th>V2</th>
      <th class="g">Fair V1</th><th>Fair V2</th><th class="g">Edge V1</th><th>Edge V2</th></tr>`;
    const sig = (f, o) => {
      const s = signal(f, o);
      if (!s) return '<td class="muted">–</td>';
      return `<td class="${s.kind}" title="${fmtPct(s.pct, 0)} of the ${s.kind === 'buy' ? 'ask' : 'bid'}"><span class="badge">${s.kind === 'buy' ? '▲ Buy' : '▼ Sell'}</span> ${fmtUsd(s.amt)}</td>`;
    };
    const diff = (p, ref) => {
      if (!isFinite(p) || !isFinite(ref)) return '';
      const d = p - ref;
      return Math.abs(d) >= 0.05 ? (d > 0 ? ' hi' : ' lo') : '';
    };
    const body = r.map(x => `<tr${Math.abs(x.moneyness) < 0.02 ? ' class="atm"' : ''}>
      <td class="sticky">${fmtUsd(x.o.strike)}</td><td class="muted">${(x.moneyness >= 0 ? '+' : '') + fmtPct(x.moneyness, 1)}</td>
      <td>${fmtUsd(x.o.bid)}</td><td>${fmtUsd(x.o.mark)}</td><td>${fmtUsd(x.o.ask)}</td><td class="muted">${fmtPct(x.o.iv, 0)}</td>
      <td class="g">${fmtPct(x.pMkt)}</td><td class="${diff(x.p1, x.pMkt)}">${fmtPct(x.p1)}</td><td class="${diff(x.p2, x.pMkt)}">${fmtPct(x.p2)}</td>
      <td class="g">${fmtPct(x.t1)}</td><td>${fmtPct(x.t2)}</td>
      <td class="g">${fmtUsd(x.f1)}</td><td>${fmtUsd(x.f2)}</td>${sig(x.f1, x.o).replace('<td class="', '<td class="g ')}${sig(x.f2, x.o)}</tr>`).join('');
    $('#table').innerHTML = `<table><thead>${head}</thead><tbody>${body || '<tr><td colspan="15">No strikes in range.</td></tr>'}</tbody></table>`;
    $('#table-title').textContent = `${isCall ? 'Calls' : 'Puts'} · ${fmtDate(ex.expiry)} · ${r.length} strikes`;
  }

  // ---------- controls ----------
  function fillExpiries() {
    state.expiries = groupExpiries(state.data, state.settle);
    if (!state.expiries.some(e => e.expiry === state.expiry)) {
      const def = state.expiries.find(e => e.days >= 6) || state.expiries[0];
      state.expiry = def && def.expiry;
    }
    $('#expiry').innerHTML = state.expiries.map(e =>
      `<option value="${e.expiry}"${e.expiry === state.expiry ? ' selected' : ''}>${fmtDate(e.expiry)} · ${fmtDays(e.days)}</option>`).join('');
  }

  function bind() {
    $('#expiry').addEventListener('change', e => { state.expiry = +e.target.value; render(); });
    $('#settle').addEventListener('change', e => { state.settle = e.target.value; fillExpiries(); render(); });
    document.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => {
      state.side = b.dataset.side;
      document.querySelectorAll('[data-side]').forEach(x => x.setAttribute('aria-pressed', x === b));
      render();
    }));
    $('#range').addEventListener('change', e => { state.range = +e.target.value; render(); });
    for (const k of ['lookback', 'halfLife', 'vol', 'drift']) {
      $('#v2-' + k).addEventListener('change', e => {
        state.v2[k] = isNaN(+e.target.value) ? e.target.value : +e.target.value;
        render();
      });
    }
    $('#refresh').addEventListener('click', () => start(true));
    let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
  }

  async function start(refresh) {
    $('#status').textContent = 'Loading…';
    $('#error').hidden = true;
    try {
      if (refresh) try { localStorage.removeItem('btc-odds-klines-v1'); } catch (e) { /* ignore */ }
      state.data = prepare(await Data.load(DEMO));
      const s = state.data.settles;
      state.settle = s.includes(state.settle) ? state.settle : (s.includes('USDC') ? 'USDC' : s[0]);
      $('#settle').innerHTML = s.map(x => `<option${x === state.settle ? ' selected' : ''}>${esc(x)}</option>`).join('');
      $('#settle-wrap').hidden = s.length < 2;
      fillExpiries();
      const c = state.data.candles;
      $('#status').innerHTML = `BTC ${fmtUsd(state.data.spot)} · ${esc(state.data.source)} · history ${fmtDate(c[0].t)} → ${fmtDate(c[c.length - 1].t)} (${c.length} days) · ${new Date(state.data.now).toLocaleTimeString()}`;
      render();
    } catch (e) {
      $('#status').textContent = '';
      $('#error').hidden = false;
      $('#error').innerHTML = `${esc(e.message)} <a href="?demo=1">Open demo</a>`;
    }
  }

  bind();
  start(false);
})();
