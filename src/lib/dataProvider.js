// ════════════════════════════════════════════════════════════════════
// dataProvider.js — the data abstraction layer
// Everything the terminal renders comes through THIS interface. To go
// live, implement the same functions against a real API (Polygon,
// Tradier, etc.) and the UI doesn't change. That's the whole point.
// ════════════════════════════════════════════════════════════════════

import { syntheticIV, bs, ivRank, ivPercentile } from "./quant.js";

export const RISK_FREE = 0.043;

// ── universe ──
export const UNIVERSE = [
  { sym: "NVDA", name: "NVIDIA", S: 138.4, sector: "Technology", region: "US", baseVol: 50, drift: 0.0007, earningsInDays: 8 },
  { sym: "AAPL", name: "Apple", S: 227.1, sector: "Technology", region: "US", baseVol: 24, drift: 0.0003, earningsInDays: 34 },
  { sym: "TSLA", name: "Tesla", S: 251.6, sector: "Consumer Disc", region: "US", baseVol: 58, drift: 0.0005, earningsInDays: 5 },
  { sym: "SPY", name: "S&P 500 ETF", S: 592.3, sector: "Index", region: "US", baseVol: 14, drift: 0.0002, earningsInDays: null },
  { sym: "QQQ", name: "Nasdaq 100 ETF", S: 511.8, sector: "Index", region: "US", baseVol: 18, drift: 0.0002, earningsInDays: null },
  { sym: "AMD", name: "Adv Micro Dev", S: 122.8, sector: "Technology", region: "US", baseVol: 46, drift: 0.0006, earningsInDays: 12 },
  { sym: "META", name: "Meta Platforms", S: 591.2, sector: "Technology", region: "US", baseVol: 33, drift: 0.0004, earningsInDays: 19 },
  { sym: "GLD", name: "Gold ETF", S: 271.4, sector: "Commodities", region: "Global", baseVol: 16, drift: 0.0003, earningsInDays: null },
  { sym: "JPM", name: "JPMorgan", S: 248.9, sector: "Financials", region: "US", baseVol: 22, drift: 0.0002, earningsInDays: 27 },
  { sym: "XOM", name: "Exxon Mobil", S: 117.3, sector: "Energy", region: "US", baseVol: 26, drift: 0.0003, earningsInDays: 22 },
  { sym: "COIN", name: "Coinbase", S: 289.5, sector: "Financials", region: "US", baseVol: 76, drift: 0.0009, earningsInDays: 15 },
  { sym: "ASML", name: "ASML Holding", S: 712.4, sector: "Technology", region: "EU", baseVol: 38, drift: 0.0004, earningsInDays: 9 },
  { sym: "MC.PA", name: "LVMH", S: 642.0, sector: "Consumer Disc", region: "EU", baseVol: 28, drift: 0.0003, earningsInDays: 41 },
  { sym: "BTC", name: "Bitcoin", S: 84200, sector: "Crypto", region: "Global", baseVol: 62, drift: 0.0010, earningsInDays: null },
];

export const EXPIRIES = [
  { label: "7d", T: 7 / 365 },
  { label: "14d", T: 14 / 365 },
  { label: "21d", T: 21 / 365 },
  { label: "30d", T: 30 / 365 },
  { label: "45d", T: 45 / 365 },
  { label: "60d", T: 60 / 365 },
  { label: "90d", T: 90 / 365 },
  { label: "180d", T: 180 / 365 },
];

// ── per-ticker synthetic IV-history (for IV rank/percentile) ──
// In production: store daily ATM IV snapshots in Postgres and read them.
const IV_HISTORY = {};
function buildHistory(sym, baseVol) {
  if (IV_HISTORY[sym]) return IV_HISTORY[sym];
  const hist = [];
  let v = baseVol / 100;
  for (let i = 0; i < 252; i++) {
    v = Math.max(0.06, v * (1 + (Math.random() - 0.5) * 0.08));
    hist.push(v);
  }
  IV_HISTORY[sym] = hist;
  return hist;
}

// ── build a full option chain for a ticker/expiry ──
export function getChain(ticker, spot, T, strikesEachSide = 8, stepPct = 0.025) {
  const rows = [];
  for (let i = -strikesEachSide; i <= strikesEachSide; i++) {
    const K = roundStrike(spot * (1 + i * stepPct), spot);
    const m = K / spot;
    const iv = syntheticIV(ticker.baseVol, m, T);
    const call = bs(spot, K, T, RISK_FREE, iv, "call");
    const put = bs(spot, K, T, RISK_FREE, iv, "put");
    // synthetic OI / volume with ATM concentration
    const atmCloseness = Math.exp(-Math.pow((m - 1) * 8, 2));
    const oi = Math.round(500 + atmCloseness * 9000 + Math.random() * 800);
    const vol = Math.round(oi * (0.1 + Math.random() * 0.6));
    rows.push({ K, m, iv, call, put, oi, vol, atm: i === 0 });
  }
  return rows;
}

function roundStrike(x, spot) {
  if (spot > 1000) return Math.round(x / 5) * 5;
  if (spot > 100) return Math.round(x);
  if (spot > 20) return Math.round(x * 2) / 2;
  return Math.round(x * 4) / 4;
}

// ── IV-rank table for the screener ──
export function getScreener(spots) {
  return UNIVERSE.map((t) => {
    const spot = spots[t.sym] || t.S;
    const hist = buildHistory(t.sym, t.baseVol);
    const atmIV = syntheticIV(t.baseVol, 1, 30 / 365);
    return {
      ...t,
      spot,
      atmIV: atmIV * 100,
      ivRank: ivRank(atmIV, hist),
      ivPctile: ivPercentile(atmIV, hist),
      // term-structure slope: front IV minus back IV (inverted = event vol)
      termSlope:
        (syntheticIV(t.baseVol, 1, 7 / 365) - syntheticIV(t.baseVol, 1, 90 / 365)) * 100,
    };
  });
}

// ── unusual options flow generator ──
export function makeFlowEvent(spots, idSeed) {
  const t = UNIVERSE[Math.floor(Math.random() * UNIVERSE.length)];
  const spot = spots[t.sym] || t.S;
  const side = Math.random() > 0.48 ? "C" : "P";
  const prem = Math.round(40 + Math.random() * 1400);
  const strike = roundStrike(spot * (1 + (Math.random() - 0.5) * 0.15), spot);
  const exp = EXPIRIES[Math.floor(Math.random() * EXPIRIES.length)].label;
  const sweep = Math.random() > 0.55;
  const aggressive = Math.random() > 0.5 ? "ASK" : "BID";
  return { id: idSeed, sym: t.sym, side, prem, strike, exp, sweep, aggressive, spot, ago: 0 };
}

// ════════════════════════════════════════════════════════════════════
// ECONOMIC CALENDAR
// Synthetic but realistic recurring macro events with expected vol impact.
// In production: pull from a calendar API (Trading Economics, Finnhub,
// FMP) and keep the impact/affected mapping.
// ════════════════════════════════════════════════════════════════════
export const ECON_EVENTS = [
  { time: "08:30", tz: "ET", name: "US CPI (YoY)", impact: 3, region: "US", cons: "2.9%", prev: "3.0%", affects: ["SPY", "QQQ", "GLD", "rates"], note: "Top vol driver. Front-month IV usually bid into the print." },
  { time: "08:30", tz: "ET", name: "US Core CPI (MoM)", impact: 3, region: "US", cons: "0.3%", prev: "0.3%", affects: ["SPY", "rates"], note: "Sticky core keeps cuts on hold." },
  { time: "14:00", tz: "ET", name: "FOMC Rate Decision", impact: 3, region: "US", cons: "Hold", prev: "Hold", affects: ["SPY", "QQQ", "rates", "GLD"], note: "Largest single-event vol. Term structure often inverts into it." },
  { time: "08:30", tz: "ET", name: "Nonfarm Payrolls", impact: 3, region: "US", cons: "165k", prev: "142k", affects: ["SPY", "rates"], note: "Labor strength → fewer cuts priced." },
  { time: "08:30", tz: "ET", name: "US Retail Sales", impact: 2, region: "US", cons: "0.4%", prev: "0.6%", affects: ["SPY", "XLY"], note: "Consumer health gauge." },
  { time: "10:00", tz: "ET", name: "ISM Manufacturing PMI", impact: 2, region: "US", cons: "49.2", prev: "48.7", affects: ["SPY", "XOM"], note: "Below 50 = contraction." },
  { time: "08:15", tz: "CET", name: "ECB Rate Decision", impact: 3, region: "EU", cons: "Hold", prev: "Cut 25bp", affects: ["ASML", "MC.PA", "EURUSD"], note: "Drives European-listed vol (ASML, LVMH)." },
  { time: "04:00", tz: "CET", name: "Euro-area Flash CPI", impact: 2, region: "EU", cons: "2.4%", prev: "2.5%", affects: ["EURUSD", "ASML"], note: "Feeds ECB path." },
  { time: "10:30", tz: "ET", name: "EIA Crude Inventories", impact: 2, region: "US", cons: "-1.2M", prev: "+3.1M", affects: ["XOM", "WTI"], note: "Energy-sector vol catalyst." },
  { time: "—", tz: "", name: "NVDA Earnings (AMC)", impact: 3, region: "US", cons: "EPS 0.84", prev: "0.78", affects: ["NVDA", "SMH", "QQQ"], note: "Single-name event: IV crush expected after the print." },
];

// assign each event a relative day offset for a 5-day calendar view
export function getCalendar() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const today = new Date();
  return days.map((d, i) => {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    // deterministically scatter events across the week
    const events = ECON_EVENTS.filter((_, idx) => idx % 5 === i).map((e) => ({ ...e }));
    return {
      day: d,
      dateLabel: date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      isToday: i === 0,
      events,
    };
  });
}

// ════════════════════════════════════════════════════════════════════
// GOING LIVE — implement these against a real provider and you're done:
//
//   getScreener(spots)        → batch quote + your stored IV history
//   getChain(ticker, S, T)    → real chain w/ bid/ask/OI/vol + market IV
//                               (or impliedVol() on mid prices)
//   makeFlowEvent(...)        → replace with a real flow websocket/feed
//   getCalendar()             → Trading Economics / Finnhub calendar API
//
// PROVIDERS:
//   • Quotes/chains: Polygon.io, Tradier (free delayed), Twelve Data
//   • Options IV/greeks/flow: ORATS, Unusual Whales, CBOE
//   • Macro calendar: Trading Economics, Finnhub, FMP
//   • Risk-free rate: FRED (DGS3MO / DGS1)
//
// Keep all keys server-side (Supabase Edge Function / Vercel serverless).
// ════════════════════════════════════════════════════════════════════
