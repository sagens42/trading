/*
 * Probability model for BTC price at an option expiry, built from history.
 * Pure functions, no DOM: runs in the browser (window.Model) and in Node (module.exports).
 *
 * Candles: ascending array of {t, o, h, l, c} daily bars (t = open time, ms UTC).
 */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const VOL_HALF_LIFE_DAYS = 30; // how fast a volatility shock fades toward the long-run level

  // Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8).
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  }

  // Black-76 on a forward. T in years, sigma annualised.
  function black76(F, K, T, sigma, isCall) {
    if (!(T > 0) || !(sigma > 0)) return Math.max(isCall ? F - K : K - F, 0);
    const s = sigma * Math.sqrt(T);
    const d1 = (Math.log(F / K) + 0.5 * s * s) / s;
    const d2 = d1 - s;
    return isCall ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
  }

  // Risk-neutral probability that the forward finishes above K, from that strike's implied vol.
  function impliedProbAbove(F, K, T, sigma) {
    if (!(T > 0) || !(sigma > 0)) return F > K ? 1 : 0;
    const s = sigma * Math.sqrt(T);
    return normCdf((Math.log(F / K) - 0.5 * s * s) / s);
  }

  // EWMA (RiskMetrics) daily volatility known at the close of each bar.
  function ewmaVol(candles, lambda) {
    const n = candles.length;
    const out = new Float64Array(n);
    if (n < 3) return out;
    const seedN = Math.min(30, n - 1);
    let v = 0;
    for (let i = 1; i <= seedN; i++) { const r = Math.log(candles[i].c / candles[i - 1].c); v += r * r; }
    v /= seedN;
    out[0] = Math.sqrt(v);
    for (let i = 1; i < n; i++) {
      const r = Math.log(candles[i].c / candles[i - 1].c);
      v = lambda * v + (1 - lambda) * r * r;
      out[i] = Math.sqrt(v);
    }
    return out;
  }

  // Long-run daily volatility (root mean square of daily log returns).
  function longRunVol(candles) {
    let s = 0, k = 0;
    for (let i = 1; i < candles.length; i++) { const r = Math.log(candles[i].c / candles[i - 1].c); s += r * r; k++; }
    return k ? Math.sqrt(s / k) : 0;
  }

  // Expected average daily vol over the next h days, starting from sigma0 and
  // decaying exponentially toward sigmaLR (standard GARCH-style term structure).
  function horizonVol(sigma0, sigmaLR, h) {
    const kappa = Math.LN2 / VOL_HALF_LIFE_DAYS;
    const x = kappa * Math.max(h, 1e-9);
    const blend = (1 - Math.exp(-x)) / x;
    return Math.sqrt(sigmaLR * sigmaLR + (sigma0 * sigma0 - sigmaLR * sigmaLR) * blend);
  }

  /*
   * Every overlapping n-day window in history -> one sample of
   *   r  = ln(close at end / close at start)
   *   up = ln(highest high inside the window / start close)
   *   dn = ln(lowest low inside the window / start close)
   *
   * opts (all optional; defaults reproduce V1 = raw history):
   *   startIdx    first window start index (lookback)
   *   targetVol   daily vol to rescale every window to (V2 regime scaling); null = no scaling
   *   volArr      EWMA vol per bar (required with targetVol)
   *   volLR       long-run daily vol (required with targetVol)
   *   timeScale   extra multiplier on returns (sqrt(T/n) to fix rounding to whole days)
   *   halfLife    recency weighting half-life in days (0 = equal weights)
   *   demean      remove drift so the expected end price equals the start price
   */
  function buildSamples(candles, n, opts) {
    opts = opts || {};
    const last = candles.length - 1;
    const start = Math.max(0, opts.startIdx || 0);
    const r = [], up = [], dn = [], w = [];
    for (let i = start; i + n <= last; i++) {
      const c0 = candles[i].c;
      let hi = -Infinity, lo = Infinity;
      for (let j = i + 1; j <= i + n; j++) {
        if (candles[j].h > hi) hi = candles[j].h;
        if (candles[j].l < lo) lo = candles[j].l;
      }
      let f = opts.timeScale || 1;
      if (opts.targetVol) {
        const then = horizonVol(opts.volArr[i], opts.volLR, n);
        if (then > 0) f *= opts.targetVol / then;
      }
      const rr = Math.log(candles[i + n].c / c0) * f;
      r.push(rr);
      up.push(Math.max(Math.log(hi / c0) * f, rr, 0));
      dn.push(Math.min(Math.log(lo / c0) * f, rr, 0));
      w.push(opts.halfLife > 0 ? Math.pow(0.5, (last - (i + n)) / opts.halfLife) : 1);
    }
    let sumW = 0, sumW2 = 0;
    for (let k = 0; k < r.length; k++) { sumW += w[k]; sumW2 += w[k] * w[k]; }
    if (opts.demean && sumW) {
      // Shift so the expected price equals the starting price (a martingale, like
      // a forward): E[exp(r)] = 1. Removing only the mean log return would leave
      // E[price] above start by about half the variance and overprice calls.
      let em = 0;
      for (let k = 0; k < r.length; k++) em += w[k] * Math.exp(r[k]);
      const shift = Math.log(em / sumW);
      for (let k = 0; k < r.length; k++) {
        r[k] -= shift;
        up[k] = Math.max(up[k] - shift, r[k], 0);
        dn[k] = Math.min(dn[k] - shift, r[k], 0);
      }
    }
    let m2 = 0, m = 0;
    for (let k = 0; k < r.length; k++) m += w[k] * r[k];
    m = sumW ? m / sumW : 0;
    for (let k = 0; k < r.length; k++) m2 += w[k] * (r[k] - m) * (r[k] - m);
    const variance = sumW ? m2 / sumW : 0;
    // Overlapping windows share most of their days: roughly one independent
    // observation per n days, further reduced by uneven weights.
    const kish = sumW2 ? (sumW * sumW) / sumW2 : 0;
    return {
      n, r, up, dn, w, sumW,
      count: r.length,
      effective: kish / n,
      meanReturn: m,
      annualVol: Math.sqrt(variance * 365 / n),
    };
  }

  // Probabilities and fair values for one strike, prices centred on S0.
  function evaluate(s, S0, K) {
    let above = 0, touch = 0, call = 0, put = 0;
    const lk = Math.log(K / S0);
    const upside = K >= S0;
    for (let k = 0; k < s.count; k++) {
      const wk = s.w[k];
      const ST = S0 * Math.exp(s.r[k]);
      if (s.r[k] > lk) above += wk;
      if (upside ? s.up[k] >= lk : s.dn[k] <= lk) touch += wk;
      if (ST > K) call += wk * (ST - K); else put += wk * (K - ST);
    }
    const W = s.sumW || 1;
    return { pAbove: above / W, pTouch: touch / W, callFair: call / W, putFair: put / W };
  }

  // P(finish above x) on a grid of prices, for the chart.
  function survivalCurve(s, S0, xs) {
    const idx = s.r.map((_, k) => k).sort((a, b) => s.r[a] - s.r[b]);
    const sortedR = idx.map(k => s.r[k]);
    const cumW = new Float64Array(idx.length + 1); // weight strictly above position
    for (let k = idx.length - 1; k >= 0; k--) cumW[k] = cumW[k + 1] + s.w[idx[k]];
    const W = cumW[0] || 1;
    return xs.map(x => {
      const lk = Math.log(x / S0);
      let lo = 0, hi = sortedR.length; // first index with r > lk
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedR[mid] > lk) hi = mid; else lo = mid + 1; }
      return cumW[lo] / W;
    });
  }

  // Drop today's still-forming bar.
  function completedCandles(candles, now) {
    return candles.filter(c => c.t + DAY <= now);
  }

  const api = { DAY, VOL_HALF_LIFE_DAYS, normCdf, black76, impliedProbAbove, ewmaVol, longRunVol,
    horizonVol, buildSamples, evaluate, survivalCurve, completedCandles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Model = api;
})(typeof self !== 'undefined' ? self : this);
