# ◰ Vol Terminal — Options · Volatility · Macro Desk

A functional options-analytics terminal with a **real quantitative engine**. Black–Scholes pricing, full Greeks, an implied-volatility solver, vol surface / term-structure / skew visualisation, a multi-leg strategy builder with live payoff diagrams, an unusual-options-flow feed, and a macro economic calendar rated by expected volatility impact.

The market **data** is currently simulated by a realistic model, so the terminal is fully usable out of the box. The **quant engine is real** — when you wire up a live data provider, nothing in the UI or the math has to change.

```
phosphor-on-black terminal aesthetic · React + Vite · deploy on Vercel
```

## What it does

| Panel | What it's for |
|---|---|
| **Screener** | Rank the universe by IV rank, IV30, term-structure slope. Filter by region / sector. Earnings-soon flags (E-n). |
| **Chain + Greeks** | Full option chain around spot with price, Δ Γ Θ V, OI and volume. Volume > OI highlighted. |
| **Vol Surface** | IV heatmap across expiry × moneyness. Read the put skew and term premium directly. |
| **Term / Skew** | ATM term structure curve + put/call skew curve for the selected expiry. |
| **Strategy Builder** | Add legs (long/short calls, puts, stock). Live payoff-at-expiry diagram, breakevens, max P/L, and aggregate position Greeks. |
| **Econ Calendar** | Macro + earnings events across the week, impact-rated by expected vol effect, with affected tickers. |
| **Unusual Flow** | Streaming feed of large/sweep options trades; click to jump to the ticker. |

## The quant engine (`src/lib/quant.js`)

Pure, dependency-free, unit-tested functions:

- `bs(S, K, T, r, sigma, type, q)` — Black–Scholes price + Δ Γ Θ V ρ, plus second-order Vanna & Volga.
- `impliedVol(price, ...)` — Newton–Raphson with bisection fallback. The bridge from market prices to a vol surface.
- `strategyPayoff`, `strategyNet`, `breakevens`, `portfolioGreeks` — strategy analytics.

Verified against known values: ATM call (S=K=100, T=1, r=5%, σ=20%) = **10.4506**, put–call parity holds, IV solver round-trips to 1e-4.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
```

## Deploy to Vercel

1. Push this repo to GitHub.
2. On [vercel.com](https://vercel.com) → **Add New Project** → import the repo.
3. Vercel auto-detects Vite (config is in `vercel.json`). Click **Deploy**.

That's it — no environment variables needed for the simulated version.

## Going live with real data

All data flows through one file: **`src/lib/dataProvider.js`**. Implement the same function signatures against a real API and the rest of the app is unchanged.

| Function | Replace with |
|---|---|
| `getScreener(spots)` | Batch quotes + your stored daily IV history (for IV rank). |
| `getChain(ticker, S, T)` | Real chain: bid/ask, OI, volume, market IV — or run `impliedVol()` on mid prices. |
| `makeFlowEvent(...)` | A real flow feed (websocket/poll). |
| `getCalendar()` | A macro calendar API. |

**Providers:** Polygon.io or Tradier (free delayed) for quotes/chains · ORATS / Unusual Whales / CBOE for options IV & flow · Trading Economics / Finnhub / FMP for the calendar · FRED for the risk-free rate.

**Architecture for live data (keeps API keys server-side):**

```
Vercel serverless fn / Supabase Edge Function  (cron)
        │  pulls quotes + chains + calendar
        ▼
   Postgres (Supabase)  ← stores snapshots + daily IV history
        │
        ▼
   React frontend reads from your own API  (no keys in browser)
```

> Real-time options data is paid. **Delayed (15-min) and end-of-day data are cheap or free** and perfectly fine for a v1 and for a portfolio piece.

## Disclaimer

Educational tool. Simulated data. **Not investment advice.**
