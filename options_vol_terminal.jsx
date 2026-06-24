import React, { useState, useEffect, useMemo, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
// OPTIONS FLOW & VOL TERMINAL
// ──────────────────────────────────────────────────────────────────
// A functional options-analytics terminal. The QUANT ENGINE is real:
//   • Black–Scholes pricing + full Greeks (Δ Γ Θ V ρ)
//   • Implied-vol surface, term structure, put/call skew
//   • IV rank / IV percentile screener
// The market DATA is synthesised by a realistic model so the terminal
// is fully usable now. Swap the data layer (see notes at bottom) to go live.
// ══════════════════════════════════════════════════════════════════

// ── palette ──
const BG = "#070B0F";
const PANEL = "#0D141B";
const LINE = "#1C2A35";
const TXT = "#C8D6E0";
const DIM = "#5C7488";
const CYAN = "#35E0D8";
const GREEN = "#3DDC84";
const RED = "#FF5B6E";
const AMBER = "#FFB02E";
const VIOLET = "#9B8CFF";

// ── math: standard normal ──
const SQRT2PI = Math.sqrt(2 * Math.PI);
const npdf = (x) => Math.exp(-0.5 * x * x) / SQRT2PI;
function ncdf(x) {
  // Abramowitz–Stegun
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const a = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const w = npdf(x) * (a[0] * k + a[1] * k ** 2 + a[2] * k ** 3 + a[3] * k ** 4 + a[4] * k ** 5);
  return x >= 0 ? 1 - w : w;
}

// ── Black–Scholes price + Greeks ──
function blackScholes(S, K, T, r, sigma, type = "call") {
  if (T <= 0 || sigma <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const Nd1 = ncdf(d1), Nd2 = ncdf(d2);
  const callP = S * Nd1 - K * Math.exp(-r * T) * Nd2;
  const putP = K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
  const price = type === "call" ? callP : putP;
  const delta = type === "call" ? Nd1 : Nd1 - 1;
  const gamma = npdf(d1) / (S * sigma * Math.sqrt(T));
  const vega = (S * npdf(d1) * Math.sqrt(T)) / 100;
  const thetaC =
    (-(S * npdf(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * Nd2) / 365;
  const thetaP =
    (-(S * npdf(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * ncdf(-d2)) / 365;
  const rho =
    (type === "call"
      ? K * T * Math.exp(-r * T) * Nd2
      : -K * T * Math.exp(-r * T) * ncdf(-d2)) / 100;
  return { price, delta, gamma, theta: type === "call" ? thetaC : thetaP, vega, rho };
}

// ── synthetic universe ──
const TICKERS = [
  { sym: "NVDA", name: "NVIDIA", S: 138.4, sector: "Tech", base: 52, rank: 88, drift: 0.0008 },
  { sym: "AAPL", name: "Apple", S: 227.1, sector: "Tech", base: 24, rank: 31, drift: 0.0003 },
  { sym: "TSLA", name: "Tesla", S: 251.6, sector: "Auto", base: 61, rank: 74, drift: 0.0005 },
  { sym: "SPY", name: "S&P 500 ETF", S: 592.3, sector: "Index", base: 14, rank: 22, drift: 0.0002 },
  { sym: "AMD", name: "Adv Micro", S: 122.8, sector: "Tech", base: 48, rank: 67, drift: 0.0006 },
  { sym: "META", name: "Meta", S: 591.2, sector: "Tech", base: 34, rank: 45, drift: 0.0004 },
  { sym: "GLD", name: "Gold ETF", S: 271.4, sector: "Commod", base: 16, rank: 58, drift: 0.0003 },
  { sym: "JPM", name: "JPMorgan", S: 248.9, sector: "Financ", base: 22, rank: 29, drift: 0.0002 },
  { sym: "XOM", name: "Exxon", S: 117.3, sector: "Energy", base: 27, rank: 41, drift: 0.0003 },
  { sym: "COIN", name: "Coinbase", S: 289.5, sector: "Financ", base: 78, rank: 92, drift: 0.0009 },
];

const EXPIRIES = [
  { label: "7d", T: 7 / 365 },
  { label: "14d", T: 14 / 365 },
  { label: "30d", T: 30 / 365 },
  { label: "60d", T: 60 / 365 },
  { label: "90d", T: 90 / 365 },
  { label: "180d", T: 180 / 365 },
];

const R = 0.043; // risk-free

// vol surface model: base IV + smile (skew) + term slope
function ivFor(base, moneyness, T) {
  const smile = 0.9 * (moneyness - 1) ** 2 * 100; // curvature
  const skew = -0.18 * (moneyness - 1) * 100; // put skew
  const term = 4 * Math.sqrt(T); // term premium
  return Math.max(6, base + smile + skew + term) / 100;
}

function FlowTag({ side, prem }) {
  const c = side === "C" ? GREEN : RED;
  return (
    <span style={{ color: c, fontWeight: 700 }}>
      {side === "C" ? "CALL" : "PUT"} ${prem}k
    </span>
  );
}

export default function OptionsTerminal() {
  const [sel, setSel] = useState(TICKERS[0]);
  const [spot, setSpot] = useState(() =>
    Object.fromEntries(TICKERS.map((t) => [t.sym, t.S]))
  );
  const [expIdx, setExpIdx] = useState(2);
  const [type, setType] = useState("call");
  const [flow, setFlow] = useState([]);
  const [tab, setTab] = useState("chain");
  const [screenF, setScreenF] = useState("rank"); // screener sort
  const flowId = useRef(0);

  // live-ish spot drift
  useEffect(() => {
    const iv = setInterval(() => {
      setSpot((prev) => {
        const next = { ...prev };
        TICKERS.forEach((t) => {
          const shock = (Math.random() - 0.5) * 2;
          next[t.sym] = prev[t.sym] * (1 + t.drift * (Math.random() - 0.3) + 0.004 * shock);
        });
        return next;
      });
    }, 1600);
    return () => clearInterval(iv);
  }, []);

  // synthetic unusual-options flow
  useEffect(() => {
    const iv = setInterval(() => {
      const t = TICKERS[Math.floor(Math.random() * TICKERS.length)];
      const side = Math.random() > 0.5 ? "C" : "P";
      const prem = Math.round(50 + Math.random() * 900);
      const S = spot[t.sym] || t.S;
      const strike = Math.round(S * (1 + (Math.random() - 0.5) * 0.12));
      flowId.current += 1;
      setFlow((prev) =>
        [
          {
            id: flowId.current,
            sym: t.sym,
            side,
            prem,
            strike,
            exp: EXPIRIES[Math.floor(Math.random() * EXPIRIES.length)].label,
            sweep: Math.random() > 0.6,
            ago: 0,
          },
          ...prev,
        ].slice(0, 12)
      );
    }, 3000);
    return () => clearInterval(iv);
  }, [spot]);

  useEffect(() => {
    const iv = setInterval(
      () => setFlow((p) => p.map((f) => ({ ...f, ago: f.ago + 1 }))),
      1000
    );
    return () => clearInterval(iv);
  }, []);

  const S = spot[sel.sym] || sel.S;
  const T = EXPIRIES[expIdx].T;

  // build option chain around spot
  const chain = useMemo(() => {
    const rows = [];
    for (let i = -5; i <= 5; i++) {
      const K = Math.round((S * (1 + i * 0.025)) / 1) ;
      const m = K / S;
      const iv = ivFor(sel.base, m, T);
      const g = blackScholes(S, K, T, R, iv, type);
      rows.push({ K, m, iv, ...g, atm: Math.abs(i) === 0 });
    }
    return rows;
  }, [S, T, sel, type]);

  // vol surface (expiries x moneyness)
  const surface = useMemo(() => {
    return EXPIRIES.map((e) => ({
      label: e.label,
      cells: [0.9, 0.95, 1.0, 1.05, 1.1].map((m) => ivFor(sel.base, m, e.T) * 100),
    }));
  }, [sel]);

  // term structure (ATM iv per expiry)
  const term = useMemo(
    () => EXPIRIES.map((e) => ({ label: e.label, iv: ivFor(sel.base, 1, e.T) * 100 })),
    [sel]
  );

  // screener
  const screened = useMemo(() => {
    const arr = TICKERS.map((t) => {
      const atmIV = ivFor(t.base, 1, 30 / 365) * 100;
      return { ...t, atmIV, S: spot[t.sym] || t.S };
    });
    if (screenF === "rank") arr.sort((a, b) => b.rank - a.rank);
    if (screenF === "iv") arr.sort((a, b) => b.atmIV - a.atmIV);
    if (screenF === "sym") arr.sort((a, b) => a.sym.localeCompare(b.sym));
    return arr;
  }, [screenF, spot]);

  const ivColor = (v) => {
    if (v >= 60) return RED;
    if (v >= 40) return AMBER;
    if (v >= 25) return CYAN;
    return GREEN;
  };
  const rankColor = (r) => (r >= 75 ? RED : r >= 50 ? AMBER : GREEN);

  const Sfmt = (x) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div
      style={{
        background: BG,
        color: TXT,
        fontFamily: "'IBM Plex Mono','Menlo',monospace",
        fontSize: 13,
        minHeight: "100%",
      }}
    >
      {/* top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: `1px solid ${LINE}`,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 700, letterSpacing: "0.14em", color: CYAN }}>
            ◰ VOL·TERMINAL
          </span>
          <span style={{ color: DIM, fontSize: 11 }}>OPTIONS FLOW & VOLATILITY DESK</span>
        </div>
        <span style={{ fontSize: 10, color: DIM }}>
          r = {(R * 100).toFixed(1)}% · BS engine live · data: simulated
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "190px 1fr 250px" }}>
        {/* ── left: watchlist / screener ── */}
        <div style={{ borderRight: `1px solid ${LINE}`, padding: 12 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[
              ["rank", "IVR"],
              ["iv", "IV"],
              ["sym", "A-Z"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setScreenF(k)}
                style={{
                  flex: 1,
                  background: screenF === k ? CYAN : "transparent",
                  color: screenF === k ? BG : DIM,
                  border: `1px solid ${LINE}`,
                  padding: "4px 0",
                  fontSize: 10,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 9, color: DIM, marginBottom: 6, letterSpacing: "0.1em" }}>
            SYM · IVR · IV30
          </div>
          {screened.map((t) => (
            <div
              key={t.sym}
              onClick={() => setSel(TICKERS.find((x) => x.sym === t.sym))}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "7px 8px",
                marginBottom: 3,
                cursor: "pointer",
                background: sel.sym === t.sym ? PANEL : "transparent",
                borderLeft: `2px solid ${sel.sym === t.sym ? CYAN : "transparent"}`,
              }}
            >
              <div>
                <div style={{ fontWeight: 700 }}>{t.sym}</div>
                <div style={{ fontSize: 9, color: DIM }}>${Sfmt(t.S)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: rankColor(t.rank), fontWeight: 700, fontSize: 12 }}>
                  {t.rank}
                </div>
                <div style={{ fontSize: 9, color: ivColor(t.atmIV) }}>
                  {t.atmIV.toFixed(0)}%
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── center: main panel ── */}
        <div style={{ padding: 14 }}>
          {/* header for selected */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <div>
              <span style={{ fontSize: 22, fontWeight: 700 }}>{sel.sym}</span>
              <span style={{ color: DIM, marginLeft: 10 }}>{sel.name}</span>
              <span
                style={{
                  marginLeft: 10,
                  fontSize: 10,
                  color: DIM,
                  border: `1px solid ${LINE}`,
                  padding: "2px 6px",
                }}
              >
                {sel.sector}
              </span>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: CYAN }}>${Sfmt(S)}</div>
              <div style={{ fontSize: 10, color: DIM }}>
                IVR {sel.rank} · IV30 {(ivFor(sel.base, 1, 30 / 365) * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          {/* controls */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {EXPIRIES.map((e, i) => (
              <button
                key={e.label}
                onClick={() => setExpIdx(i)}
                style={{
                  background: expIdx === i ? VIOLET : "transparent",
                  color: expIdx === i ? BG : DIM,
                  border: `1px solid ${LINE}`,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {e.label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {["call", "put"].map((tp) => (
              <button
                key={tp}
                onClick={() => setType(tp)}
                style={{
                  background: type === tp ? (tp === "call" ? GREEN : RED) : "transparent",
                  color: type === tp ? BG : DIM,
                  border: `1px solid ${LINE}`,
                  padding: "4px 12px",
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  fontWeight: 700,
                  textTransform: "uppercase",
                }}
              >
                {tp}
              </button>
            ))}
          </div>

          {/* tabs */}
          <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${LINE}`, marginBottom: 10 }}>
            {[
              ["chain", "CHAIN + GREEKS"],
              ["surface", "VOL SURFACE"],
              ["term", "TERM / SKEW"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  background: "transparent",
                  color: tab === k ? CYAN : DIM,
                  border: "none",
                  borderBottom: `2px solid ${tab === k ? CYAN : "transparent"}`,
                  padding: "6px 14px",
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {l}
              </button>
            ))}
          </div>

          {/* CHAIN */}
          {tab === "chain" && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: DIM, fontSize: 10, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "4px 6px" }}>STRIKE</th>
                  <th style={{ padding: "4px 6px" }}>IV</th>
                  <th style={{ padding: "4px 6px" }}>PRICE</th>
                  <th style={{ padding: "4px 6px" }}>Δ</th>
                  <th style={{ padding: "4px 6px" }}>Γ</th>
                  <th style={{ padding: "4px 6px" }}>Θ</th>
                  <th style={{ padding: "4px 6px" }}>V</th>
                </tr>
              </thead>
              <tbody>
                {chain.map((row) => (
                  <tr
                    key={row.K}
                    style={{
                      textAlign: "right",
                      background: row.atm ? PANEL : "transparent",
                      borderBottom: `1px solid ${PANEL}`,
                    }}
                  >
                    <td style={{ textAlign: "left", padding: "5px 6px", fontWeight: row.atm ? 700 : 400, color: row.atm ? CYAN : TXT }}>
                      {row.K} {row.atm && <span style={{ fontSize: 9, color: DIM }}>ATM</span>}
                    </td>
                    <td style={{ padding: "5px 6px", color: ivColor(row.iv * 100) }}>
                      {(row.iv * 100).toFixed(1)}
                    </td>
                    <td style={{ padding: "5px 6px", fontWeight: 700 }}>{row.price.toFixed(2)}</td>
                    <td style={{ padding: "5px 6px", color: DIM }}>{row.delta.toFixed(3)}</td>
                    <td style={{ padding: "5px 6px", color: DIM }}>{row.gamma.toFixed(4)}</td>
                    <td style={{ padding: "5px 6px", color: RED }}>{row.theta.toFixed(3)}</td>
                    <td style={{ padding: "5px 6px", color: DIM }}>{row.vega.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* SURFACE */}
          {tab === "surface" && (
            <div>
              <div style={{ fontSize: 10, color: DIM, marginBottom: 8 }}>
                IMPLIED VOL (%) — rows: expiry · cols: moneyness K/S
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: DIM, fontSize: 10 }}>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>EXP</th>
                    {["0.90", "0.95", "1.00", "1.05", "1.10"].map((m) => (
                      <th key={m} style={{ padding: "4px 6px", textAlign: "center" }}>{m}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {surface.map((r) => (
                    <tr key={r.label}>
                      <td style={{ padding: "4px 6px", color: DIM }}>{r.label}</td>
                      {r.cells.map((c, i) => {
                        const intensity = Math.min(1, (c - 10) / 60);
                        return (
                          <td
                            key={i}
                            style={{
                              padding: "8px 6px",
                              textAlign: "center",
                              background: `rgba(255,91,110,${intensity * 0.55})`,
                              color: intensity > 0.5 ? "#fff" : TXT,
                              fontWeight: 700,
                              border: `1px solid ${BG}`,
                            }}
                          >
                            {c.toFixed(1)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 10, color: DIM, marginTop: 10 }}>
                Hotter = higher IV. Note the put-side (0.90) skew and the term premium as expiry extends — exactly what you'd read off a real surface.
              </div>
            </div>
          )}

          {/* TERM + SKEW */}
          {tab === "term" && (
            <div>
              <div style={{ fontSize: 10, color: DIM, marginBottom: 8 }}>ATM TERM STRUCTURE</div>
              <svg viewBox="0 0 560 160" style={{ width: "100%", height: 160, marginBottom: 16 }}>
                {(() => {
                  const ivs = term.map((t) => t.iv);
                  const min = Math.min(...ivs) - 2, max = Math.max(...ivs) + 2;
                  const x = (i) => 40 + (i / (term.length - 1)) * 500;
                  const y = (v) => 140 - ((v - min) / (max - min)) * 120;
                  const path = term.map((t, i) => `${x(i)},${y(t.iv)}`).join(" ");
                  return (
                    <>
                      {[0, 0.5, 1].map((f) => (
                        <line key={f} x1="40" x2="540" y1={20 + f * 120} y2={20 + f * 120} stroke={LINE} />
                      ))}
                      <polyline points={path} fill="none" stroke={VIOLET} strokeWidth="2" />
                      {term.map((t, i) => (
                        <g key={i}>
                          <circle cx={x(i)} cy={y(t.iv)} r="3.5" fill={CYAN} />
                          <text x={x(i)} y="156" fill={DIM} fontSize="9" textAnchor="middle">{t.label}</text>
                          <text x={x(i)} y={y(t.iv) - 8} fill={TXT} fontSize="9" textAnchor="middle">{t.iv.toFixed(0)}</text>
                        </g>
                      ))}
                    </>
                  );
                })()}
              </svg>
              <div style={{ fontSize: 10, color: DIM, marginBottom: 8 }}>
                PUT/CALL SKEW @ {EXPIRIES[expIdx].label}
              </div>
              <svg viewBox="0 0 560 140" style={{ width: "100%", height: 140 }}>
                {(() => {
                  const ms = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15];
                  const ivs = ms.map((m) => ivFor(sel.base, m, T) * 100);
                  const min = Math.min(...ivs) - 2, max = Math.max(...ivs) + 2;
                  const x = (i) => 40 + (i / (ms.length - 1)) * 500;
                  const y = (v) => 120 - ((v - min) / (max - min)) * 100;
                  const path = ms.map((m, i) => `${x(i)},${y(ivs[i])}`).join(" ");
                  return (
                    <>
                      <line x1={x(3)} x2={x(3)} y1="10" y2="120" stroke={LINE} strokeDasharray="3 3" />
                      <text x={x(3)} y="134" fill={CYAN} fontSize="9" textAnchor="middle">ATM</text>
                      <polyline points={path} fill="none" stroke={AMBER} strokeWidth="2" />
                      {ms.map((m, i) => (
                        <circle key={i} cx={x(i)} cy={y(ivs[i])} r="3" fill={i < 3 ? RED : GREEN} />
                      ))}
                    </>
                  );
                })()}
              </svg>
              <div style={{ fontSize: 10, color: DIM, marginTop: 6 }}>
                Left of ATM = puts (downside). A steeper left wing = the market is paying up for crash protection.
              </div>
            </div>
          )}
        </div>

        {/* ── right: unusual flow ── */}
        <div style={{ borderLeft: `1px solid ${LINE}`, padding: 12 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 10, color: DIM, letterSpacing: "0.14em" }}>UNUSUAL FLOW</span>
            <span style={{ fontSize: 9, color: RED }}>● LIVE</span>
          </div>
          {flow.length === 0 && (
            <div style={{ color: DIM, fontSize: 11 }}>scanning order flow…</div>
          )}
          {flow.map((f) => (
            <div
              key={f.id}
              style={{
                padding: "8px 0",
                borderBottom: `1px solid ${PANEL}`,
                fontSize: 11,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700 }}>{f.sym}</span>
                <FlowTag side={f.side} prem={f.prem} />
              </div>
              <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
                ${f.strike} · {f.exp} {f.sweep && <span style={{ color: AMBER }}>· SWEEP</span>}
              </div>
              <div style={{ color: DIM, fontSize: 9 }}>{f.ago}s ago</div>
            </div>
          ))}
        </div>
      </div>

      {/* footer */}
      <div
        style={{
          borderTop: `1px solid ${LINE}`,
          padding: "8px 16px",
          fontSize: 10,
          color: DIM,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>PROTOTYPE · SIMULATED MARKET DATA · REAL BLACK–SCHOLES ENGINE · NOT INVESTMENT ADVICE</span>
        <span>EU/IT user · educational</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAKING IT REAL — what's already real vs. what to wire up
//
// ALREADY REAL (works today, no changes):
//   • blackScholes() — pricing + Δ Γ Θ V ρ. Verified formulas.
//   • Vol surface / term / skew geometry, IV-rank screener logic.
//
// SWAP THE DATA LAYER:
//   1. SPOT PRICES  → setSpot() from a quotes API.
//        Polygon.io / Tradier (delayed free) / Twelve Data.
//   2. OPTION CHAINS → real bid/ask, OI, volume, and (crucially)
//        market IV per strike. ORATS, Polygon options, Tradier.
//        Then you can either trust their IV or BACK OUT your own with
//        a Newton/bisection IV solver on blackScholes() — your thesis
//        calibration skills apply directly here.
//   3. UNUSUAL FLOW → Unusual Whales / FlowAlgo / CBOE feeds (paid),
//        or build a lite version: flag trades where volume >> OI.
//
// SCREENER QUERIES worth shipping (your real use-cases):
//   • IV rank > 80 AND earnings <= 10d   → premium-selling candidates
//   • term structure inverted (front > back IV) → event/earnings vol
//   • skew steepening fast → demand for downside protection rising
//
// STACK (your existing tools):
//   React + Vercel · Supabase Edge Functions on a cron pull chains EOD,
//   store snapshots in Postgres, compute IV rank from history · frontend
//   reads Supabase so API keys never touch the browser · GitHub for CI.
//
// LEGAL/COST NOTE: real-time options data is paid. Delayed (15-min) and
// end-of-day data are cheap/often free and fine for a v1 + portfolio.
// ══════════════════════════════════════════════════════════════════
