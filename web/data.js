/*
 * Data from Bybit's public v5 API (no key needed).
 * Tries the API directly from the browser first; if that is blocked (CORS or
 * network), falls back to the local proxy in server.js at ./bybit/...
 * ?demo=1 in the URL uses synthetic data instead.
 */
(function (root) {
  'use strict';
  const DAY = 86400000;
  // ?host=api.bytick.com picks an alternate Bybit API domain.
  const HOST = (new URLSearchParams(location.search).get('host') || 'api.bybit.com').replace(/[^a-z0-9.-]/gi, '');
  const BYBIT = 'https://' + HOST;
  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const CACHE_KEY = 'btc-odds-klines-v1';

  let route = null; // 'direct' | 'proxy', remembered after the first success

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.retCode !== 0) throw new Error('Bybit: ' + j.retMsg);
    return j.result;
  }

  async function bybit(path) {
    const order = route ? [route] : ['direct', 'proxy'];
    let lastErr;
    for (const r of order) {
      try {
        const out = await getJson(r === 'direct' ? BYBIT + path : './bybit' + path + (path.includes('?') ? '&' : '?') + 'host=' + HOST);
        route = r;
        return out;
      } catch (e) { lastErr = e; }
    }
    throw new Error('Could not reach Bybit (' + lastErr.message + '). Run node server.js, or open with ?demo=1.');
  }

  // "BTC-27DEC26-100000-C" or "BTC-27DEC26-100000-C-USDT"; Bybit options expire 08:00 UTC.
  function parseSymbol(sym) {
    const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])(?:-([A-Z]+))?$/.exec(sym);
    if (!m || !(m[2] in MONTHS)) return null;
    return {
      expiry: Date.UTC(2000 + +m[3], MONTHS[m[2]], +m[1], 8),
      strike: +m[4],
      side: m[5],
      settle: m[6] || 'USDC',
    };
  }

  async function loadOptions() {
    const res = await bybit('/v5/market/tickers?category=option&baseCoin=BTC');
    const out = [];
    for (const t of res.list || []) {
      const p = parseSymbol(t.symbol);
      if (!p) continue;
      out.push(Object.assign(p, {
        symbol: t.symbol,
        bid: +t.bid1Price || 0,
        ask: +t.ask1Price || 0,
        mark: +t.markPrice || 0,
        iv: +t.markIv || 0,
        delta: +t.delta || 0,
        underlying: +t.underlyingPrice || 0,
        index: +t.indexPrice || 0,
        oi: +t.openInterest || 0,
      }));
    }
    return out;
  }

  // Daily bars of Bybit's inverse BTCUSD perpetual: the longest history Bybit
  // has (late 2018 onward). Paged backwards 1000 bars at a time, cached for 6h.
  async function loadCandles() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && Date.now() - c.saved < 6 * 3600e3 && c.rows.length > 500) return c.rows;
    } catch (e) { /* storage unavailable */ }
    const rows = new Map();
    let end = Date.now();
    for (let page = 0; page < 12; page++) {
      const res = await bybit('/v5/market/kline?category=inverse&symbol=BTCUSD&interval=D&limit=1000&end=' + end);
      const list = res.list || [];
      for (const k of list) rows.set(+k[0], { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
      if (list.length < 1000) break;
      end = Math.min(...list.map(k => +k[0])) - 1;
    }
    const out = [...rows.values()].sort((a, b) => a.t - b.t);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ saved: Date.now(), rows: out })); } catch (e) { /* ignore */ }
    return out;
  }

  // ---------- Synthetic data for ?demo=1 (vol-clustering random walk + smiled chain) ----------
  function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  function gauss(rand) { let u = 0, v = 0; while (!u) u = rand(); v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  function demoCandles(now) {
    const rand = rng(42);
    const start = Date.UTC(2018, 10, 15);
    const today = Math.floor(now / DAY) * DAY;
    const out = [];
    let p = 5600, v = 0.035 * 0.035;
    for (let t = start; t <= today; t += DAY) {
      const sigma = Math.sqrt(v);
      const z = gauss(rand) * (rand() < 0.03 ? 2.2 : 1); // occasional fat-tail day
      const r = 0.0012 + sigma * z;
      const o = p, c = p * Math.exp(r);
      const h = Math.max(o, c) * Math.exp(Math.abs(gauss(rand)) * sigma * 0.5);
      const l = Math.min(o, c) * Math.exp(-Math.abs(gauss(rand)) * sigma * 0.5);
      out.push({ t, o, h, l, c });
      v = 0.0000045 + 0.9 * v + 0.07 * r * r;
      p = c;
    }
    const scale = 101000 / p; // land near a plausible current price
    return out.map(k => ({ t: k.t, o: k.o * scale, h: k.h * scale, l: k.l * scale, c: k.c * scale }));
  }

  function demoOptions(now, spot) {
    const M = root.Model;
    const expiries = new Set();
    const d0 = Math.floor(now / DAY) * DAY + 8 * 3600e3;
    for (let k = 1; k <= 3; k++) expiries.add(d0 + k * DAY);
    let fri = d0 + DAY;
    while (new Date(fri).getUTCDay() !== 5) fri += DAY;
    for (let k = 0; k < 5; k++) expiries.add(fri + k * 7 * DAY);
    for (const m of [1, 2, 3, 6, 9]) { const d = new Date(now); const last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0, 8); let e = last; while (new Date(e).getUTCDay() !== 5) e -= DAY; expiries.add(e); }
    const out = [];
    const step = [500, 1000, 2000, 5000];
    for (const e of [...expiries].sort((a, b) => a - b)) {
      const T = (e - now) / (365 * DAY);
      if (T <= 0) continue;
      const F = spot * Math.exp(0.06 * T);
      const width = Math.max(0.08, 3 * 0.5 * Math.sqrt(T));
      const inc = step.find(s => F * width / s <= 30) || 10000;
      for (let K = Math.ceil(F * Math.exp(-width) / inc) * inc; K <= F * Math.exp(width); K += inc) {
        const x = Math.log(K / F) / Math.sqrt(Math.max(T, 0.01));
        const iv = 0.29 + 0.04 * Math.exp(-T * 4) + 0.05 * x * x - 0.02 * x;
        for (const side of ['C', 'P']) {
          const mark = M.black76(F, K, T, iv, side === 'C');
          if (mark < 5) continue;
          const half = Math.max(5, mark * 0.025);
          const d = new Date(e);
          out.push({ symbol: `BTC-${d.getUTCDate()}${Object.keys(MONTHS)[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}-${K}-${side}`,
            expiry: e, strike: K, side, settle: 'USDC', bid: mark - half, ask: mark + half, mark, iv, delta: 0,
            underlying: F, index: spot, oi: 0 });
        }
      }
    }
    return out;
  }

  async function load(demo) {
    const now = Date.now();
    if (demo) {
      const candles = demoCandles(now);
      return { now, candles, options: demoOptions(now, candles[candles.length - 1].c), source: 'Demo data (synthetic)' };
    }
    const [candles, options] = await Promise.all([loadCandles(), loadOptions()]);
    return { now, candles, options, source: 'Bybit ' + (route === 'proxy' ? 'via local proxy' : 'live') };
  }

  root.Data = { load, parseSymbol };
})(self);
