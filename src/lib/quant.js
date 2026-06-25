// ════════════════════════════════════════════════════════════════════
// quant.js — the quantitative engine
// Pure functions, no UI, no dependencies. Fully testable in isolation.
//   • Black–Scholes price + full Greeks (Δ Γ Θ V ρ + Vanna, Volga)
//   • Implied volatility solver (Newton–Raphson w/ bisection fallback)
//   • Vol surface model (SVI-lite smile) for synthetic data
//   • Strategy P&L: per-leg + portfolio payoff at expiry and live
// ════════════════════════════════════════════════════════════════════

const SQRT2PI = Math.sqrt(2 * Math.PI);

export const npdf = (x) => Math.exp(-0.5 * x * x) / SQRT2PI;

// Standard normal CDF — Abramowitz & Stegun 7.1.26 (accuracy ~1e-7)
export function ncdf(x) {
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const a = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const poly = a[0] * k + a[1] * k ** 2 + a[2] * k ** 3 + a[3] * k ** 4 + a[4] * k ** 5;
  const w = npdf(x) * poly;
  return x >= 0 ? 1 - w : w;
}

// d1 / d2
function d1d2(S, K, T, r, sigma, q = 0) {
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma ** 2) * T) / (sigma * Math.sqrt(T));
  return [d1, d1 - sigma * Math.sqrt(T)];
}

// ── Black–Scholes price + full Greeks (with continuous dividend yield q) ──
export function bs(S, K, T, r, sigma, type = "call", q = 0) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, volga: 0 };
  }
  const [d1, d2] = d1d2(S, K, T, r, sigma, q);
  const Nd1 = ncdf(d1), Nd2 = ncdf(d2);
  const pdfd1 = npdf(d1);
  const disc = Math.exp(-r * T);
  const divDisc = Math.exp(-q * T);
  const sqrtT = Math.sqrt(T);

  const callP = S * divDisc * Nd1 - K * disc * Nd2;
  const putP = K * disc * ncdf(-d2) - S * divDisc * ncdf(-d1);
  const price = type === "call" ? callP : putP;

  const delta = type === "call" ? divDisc * Nd1 : divDisc * (Nd1 - 1);
  const gamma = (divDisc * pdfd1) / (S * sigma * sqrtT);
  const vega = (S * divDisc * pdfd1 * sqrtT) / 100; // per 1 vol point
  const thetaCommon = -(S * divDisc * pdfd1 * sigma) / (2 * sqrtT);
  const thetaCall = (thetaCommon - r * K * disc * Nd2 + q * S * divDisc * Nd1) / 365;
  const thetaPut = (thetaCommon + r * K * disc * ncdf(-d2) - q * S * divDisc * ncdf(-d1)) / 365;
  const rho =
    (type === "call" ? K * T * disc * Nd2 : -K * T * disc * ncdf(-d2)) / 100;

  // second-order
  const vanna = (-divDisc * pdfd1 * d2) / sigma / 100; // dDelta/dVol
  const volga = (S * divDisc * pdfd1 * sqrtT * d1 * d2) / sigma / 100; // dVega/dVol

  return {
    price,
    delta,
    gamma,
    theta: type === "call" ? thetaCall : thetaPut,
    vega,
    rho,
    vanna,
    volga,
  };
}

// ── Implied volatility: Newton–Raphson with bisection fallback ──
// Given a market price, back out sigma. This is the bridge from
// "I have prices" to "I have a vol surface".
export function impliedVol(marketPrice, S, K, T, r, type = "call", q = 0) {
  if (marketPrice <= 0 || T <= 0) return null;
  const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (marketPrice < intrinsic - 1e-6) return null; // arbitrage / bad quote

  let sigma = 0.25; // seed
  // Newton–Raphson
  for (let i = 0; i < 50; i++) {
    const { price, vega } = bs(S, K, T, r, sigma, type, q);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-6) return sigma;
    const v = vega * 100; // un-scale (vega above is per-point)
    if (v < 1e-8) break; // vega too small → bail to bisection
    sigma -= diff / v;
    if (sigma <= 0 || sigma > 5) break;
  }
  // Bisection fallback (robust)
  let lo = 1e-4, hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const { price } = bs(S, K, T, r, mid, type, q);
    if (Math.abs(price - marketPrice) < 1e-6) return mid;
    if (price > marketPrice) hi = mid;
    else lo = mid;
  }
  const mid = (lo + hi) / 2;
  return mid > 0.001 && mid < 4.999 ? mid : null;
}

// ── Synthetic vol surface (SVI-lite): base + skew + smile + term ──
// Used only for generating realistic fake data. Replace with real
// market IV (or impliedVol() on real prices) when you go live.
export function syntheticIV(baseVol, moneyness, T) {
  const k = Math.log(moneyness); // log-moneyness
  const smile = 1.4 * k * k; // convexity
  const skew = -0.35 * k; // put skew (negative slope)
  const term = 0.04 * Math.sqrt(T); // term premium
  return Math.max(0.06, baseVol / 100 + smile + skew + term);
}

// ── IV rank & percentile from a history array ──
export function ivRank(currentIV, history) {
  if (!history || history.length < 2) return null;
  const min = Math.min(...history);
  const max = Math.max(...history);
  if (max === min) return 50;
  return Math.round(((currentIV - min) / (max - min)) * 100);
}
export function ivPercentile(currentIV, history) {
  if (!history || history.length < 2) return null;
  const below = history.filter((v) => v < currentIV).length;
  return Math.round((below / history.length) * 100);
}

// ── Strategy P&L ──
// A leg: { type:'call'|'put'|'stock', strike, qty (+long/-short), premium }
// Returns payoff at expiry across a price grid + net debit/credit + greeks.
export function strategyPayoff(legs, spotGrid) {
  return spotGrid.map((S) => {
    let pnl = 0;
    for (const leg of legs) {
      if (leg.type === "stock") {
        pnl += leg.qty * (S - leg.premium); // premium = entry price
      } else {
        const intrinsic =
          leg.type === "call" ? Math.max(S - leg.strike, 0) : Math.max(leg.strike - S, 0);
        pnl += leg.qty * (intrinsic - leg.premium) * 100; // 100 multiplier
      }
    }
    return { S, pnl };
  });
}

export function strategyNet(legs) {
  // negative = net debit (you pay), positive = net credit (you receive)
  let net = 0;
  for (const leg of legs) {
    if (leg.type === "stock") net += -leg.qty * leg.premium;
    else net += -leg.qty * leg.premium * 100;
  }
  return net;
}

// Aggregate live Greeks of an options position
export function portfolioGreeks(legs, S, T, r) {
  const agg = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const leg of legs) {
    if (leg.type === "stock") {
      agg.delta += leg.qty;
      continue;
    }
    const iv = leg.iv || 0.3;
    const g = bs(S, leg.strike, T, r, iv, leg.type);
    agg.delta += leg.qty * g.delta * 100;
    agg.gamma += leg.qty * g.gamma * 100;
    agg.theta += leg.qty * g.theta * 100;
    agg.vega += leg.qty * g.vega * 100;
  }
  return agg;
}

// breakeven points (sign changes in payoff)
export function breakevens(payoff) {
  const bes = [];
  for (let i = 1; i < payoff.length; i++) {
    const a = payoff[i - 1], b = payoff[i];
    if (a.pnl === 0) bes.push(a.S);
    else if (a.pnl < 0 !== b.pnl < 0) {
      // linear interp
      const t = -a.pnl / (b.pnl - a.pnl);
      bes.push(a.S + t * (b.S - a.S));
    }
  }
  // dedupe near-identical crossings
  return bes.filter((v, i) => i === 0 || Math.abs(v - bes[i - 1]) > 0.5);
}
