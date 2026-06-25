import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  bs,
  syntheticIV,
  impliedVol,
  strategyPayoff,
  strategyNet,
  portfolioGreeks,
  breakevens,
} from "../lib/quant.js";
import {
  UNIVERSE,
  EXPIRIES,
  RISK_FREE,
  getChain,
  getScreener,
  makeFlowEvent,
  getCalendar,
} from "../lib/dataProvider.js";
import NeuralBackground from "@/components/ui/flow-field-background";
import { CandlestickChart } from "lucide-react";

// ── palette ── softer slate-blue, easier on the eyes than phosphor-on-black
const C = {
  bg: "#161A21",        // dark slate, not pure black
  panel: "#1D222B",     // raised surface
  panel2: "#232A35",    // selected / highlighted surface
  line: "#2E3744",      // borders
  txt: "#D6DCE4",        // primary text (soft off-white)
  dim: "#7A8696",        // secondary text
  cyan: "#5BC8D8",       // accent (desaturated teal)
  green: "#5FCB8A",      // positive (muted)
  red: "#E87784",        // negative (muted coral)
  amber: "#E0A852",      // warning (warm sand)
  violet: "#9D93D8",     // curves / secondary accent
};

// font stack — sober technical mono
const FONT = "'JetBrains Mono','Roboto Mono',ui-monospace,SFMono-Regular,Menlo,monospace";

const fmt = (x, d = 2) =>
  x == null ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

const ivColor = (v) => (v >= 60 ? C.red : v >= 40 ? C.amber : v >= 25 ? C.cyan : C.green);
const rankColor = (r) => (r == null ? C.dim : r >= 75 ? C.red : r >= 50 ? C.amber : C.green);
const impactDots = (n) =>
  "●".repeat(n) + "○".repeat(3 - n);

export default function VolTerminal() {
  const [spots, setSpots] = useState(() =>
    Object.fromEntries(UNIVERSE.map((t) => [t.sym, t.S]))
  );
  const [selSym, setSelSym] = useState("NVDA");
  const [expIdx, setExpIdx] = useState(3);
  const [chainType, setChainType] = useState("call");
  const [tab, setTab] = useState("chain");
  const [sortKey, setSortKey] = useState("ivRank");
  const [regionFilter, setRegionFilter] = useState("All");
  const [sectorFilter, setSectorFilter] = useState("All");
  const [flow, setFlow] = useState([]);
  const [flowFilter, setFlowFilter] = useState("all");
  const [legs, setLegs] = useState([]);
  const flowId = useRef(0);

  const sel = UNIVERSE.find((t) => t.sym === selSym);
  const S = spots[selSym] || sel.S;
  const T = EXPIRIES[expIdx].T;

  // ── live spot drift ──
  useEffect(() => {
    const iv = setInterval(() => {
      setSpots((prev) => {
        const n = { ...prev };
        UNIVERSE.forEach((t) => {
          const shock = (Math.random() - 0.5) * 2;
          n[t.sym] = prev[t.sym] * (1 + t.drift * (Math.random() - 0.3) + 0.0045 * shock);
        });
        return n;
      });
    }, 1500);
    return () => clearInterval(iv);
  }, []);

  // ── flow feed ──
  useEffect(() => {
    const iv = setInterval(() => {
      flowId.current += 1;
      setFlow((prev) => [makeFlowEvent(spots, flowId.current), ...prev].slice(0, 30));
    }, 2600);
    return () => clearInterval(iv);
  }, [spots]);

  useEffect(() => {
    const iv = setInterval(() => setFlow((p) => p.map((f) => ({ ...f, ago: f.ago + 1 }))), 1000);
    return () => clearInterval(iv);
  }, []);

  // ── screener data ──
  const screener = useMemo(() => {
    let arr = getScreener(spots);
    if (regionFilter !== "All") arr = arr.filter((t) => t.region === regionFilter);
    if (sectorFilter !== "All") arr = arr.filter((t) => t.sector === sectorFilter);
    arr.sort((a, b) => {
      if (sortKey === "sym") return a.sym.localeCompare(b.sym);
      if (sortKey === "atmIV") return b.atmIV - a.atmIV;
      if (sortKey === "termSlope") return b.termSlope - a.termSlope;
      return (b.ivRank ?? 0) - (a.ivRank ?? 0);
    });
    return arr;
  }, [spots, regionFilter, sectorFilter, sortKey]);

  const regions = ["All", ...new Set(UNIVERSE.map((t) => t.region))];
  const sectors = ["All", ...new Set(UNIVERSE.map((t) => t.sector))];

  // ── chain ──
  const chain = useMemo(() => getChain(sel, S, T), [sel, S, T]);

  // ── vol surface ──
  const moneynessCols = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15];
  const surface = useMemo(
    () =>
      EXPIRIES.map((e) => ({
        label: e.label,
        cells: moneynessCols.map((m) => syntheticIV(sel.baseVol, m, e.T) * 100),
      })),
    [sel]
  );

  const filteredFlow = flow.filter((f) =>
    flowFilter === "all" ? true : flowFilter === "calls" ? f.side === "C" : f.side === "P"
  );

  // ── strategy builder ──
  const addLeg = useCallback(
    (type, side) => {
      const atmStrike = chain.find((r) => r.atm)?.K || Math.round(S);
      const opt = type === "call" ? chain.find((r) => r.atm)?.call : chain.find((r) => r.atm)?.put;
      const prem = type === "stock" ? S : opt?.price || 1;
      const iv = type === "stock" ? 0 : syntheticIV(sel.baseVol, 1, T);
      setLegs((prev) => [
        ...prev,
        { id: Date.now() + Math.random(), type, strike: atmStrike, qty: side, premium: prem, iv, sym: selSym },
      ]);
    },
    [chain, S, sel, T, selSym]
  );

  const updateLeg = (id, field, val) =>
    setLegs((prev) => prev.map((l) => (l.id === id ? { ...l, [field]: val } : l)));
  const removeLeg = (id) => setLegs((prev) => prev.filter((l) => l.id !== id));

  const payoffData = useMemo(() => {
    if (legs.length === 0) return null;
    const center = legs[0].type === "stock" ? legs[0].premium : legs[0].strike;
    const lo = center * 0.7, hi = center * 1.3;
    const grid = Array.from({ length: 120 }, (_, i) => lo + (i / 119) * (hi - lo));
    const payoff = strategyPayoff(legs, grid);
    return {
      payoff,
      net: strategyNet(legs),
      bes: breakevens(payoff),
      greeks: portfolioGreeks(legs, S, T, RISK_FREE),
      maxProfit: Math.max(...payoff.map((p) => p.pnl)),
      maxLoss: Math.min(...payoff.map((p) => p.pnl)),
    };
  }, [legs, S, T]);

  const calendar = useMemo(() => getCalendar(), []);

  return (
    <>
      {/* ── animated flow-field backdrop — subtle so the data stays readable ── */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} aria-hidden>
        <NeuralBackground color="#818cf8" trailOpacity={0.07} particleCount={500} speed={0.65} />
      </div>

      {/* glass desk surface: ~80% opaque + blur keeps tables crisp while the flow shows through */}
      <div style={{ position: "relative", zIndex: 1, background: "rgba(22,26,33,0.8)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", color: C.txt, fontFamily: FONT, fontSize: 13, minHeight: "100%" }}>
      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 16, letterSpacing: "0.01em" }}>
            <CandlestickChart size={18} style={{ color: "#818cf8" }} />
            <span style={{ background: "linear-gradient(90deg,#a5b4fc,#818cf8 45%,#5BC8D8)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent" }}>OddsFinance</span>
          </span>
          <span style={{ color: C.dim, fontSize: 11 }}>OPTIONS · VOLATILITY · MACRO DESK</span>
        </div>
        <span style={{ fontSize: 10, color: C.dim, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green, display: "inline-block" }} />
          simulated data
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "212px 1fr 248px" }}>
        {/* ════ LEFT: screener ════ */}
        <div style={{ borderRight: `1px solid ${C.line}`, padding: 10, maxHeight: 760, overflowY: "auto" }}>
          <Label>SCREENER</Label>
          {/* filters */}
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            <Select value={regionFilter} onChange={setRegionFilter} options={regions} />
            <Select value={sectorFilter} onChange={setSectorFilter} options={sectors} />
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {[["ivRank", "IVR"], ["atmIV", "IV"], ["termSlope", "TERM"], ["sym", "A-Z"]].map(([k, l]) => (
              <button key={k} onClick={() => setSortKey(k)} style={btn(sortKey === k)}>{l}</button>
            ))}
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
            <span>SYM</span><span>IVR · IV30</span>
          </div>
          {screener.map((t) => (
            <div key={t.sym} onClick={() => setSelSym(t.sym)} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "6px 7px", marginBottom: 2, cursor: "pointer",
              background: selSym === t.sym ? C.panel2 : "transparent",
              borderLeft: `2px solid ${selSym === t.sym ? C.cyan : "transparent"}`,
            }}>
              <div>
                <div style={{ fontWeight: 700 }}>{t.sym}
                  {t.earningsInDays != null && t.earningsInDays <= 10 && (
                    <span style={{ color: C.amber, fontSize: 8, marginLeft: 4 }}>E-{t.earningsInDays}</span>
                  )}
                </div>
                <div style={{ fontSize: 9, color: C.dim }}>${fmt(t.spot)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: rankColor(t.ivRank), fontWeight: 700 }}>{t.ivRank}</div>
                <div style={{ fontSize: 9, color: ivColor(t.atmIV) }}>{t.atmIV.toFixed(0)}%</div>
              </div>
            </div>
          ))}
        </div>

        {/* ════ CENTER ════ */}
        <div style={{ padding: 14, maxHeight: 760, overflowY: "auto" }}>
          {/* selected header */}
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <span style={{ fontSize: 22, fontWeight: 700 }}>{sel.sym}</span>
              <span style={{ color: C.dim, marginLeft: 10 }}>{sel.name}</span>
              <span style={tag()}>{sel.sector}</span>
              <span style={tag()}>{sel.region}</span>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.cyan }}>${fmt(S)}</div>
              <div style={{ fontSize: 10, color: C.dim }}>IV30 {(syntheticIV(sel.baseVol, 1, 30 / 365) * 100).toFixed(1)}%
                {sel.earningsInDays != null && <span style={{ color: C.amber }}> · ER in {sel.earningsInDays}d</span>}
              </div>
            </div>
          </div>

          {/* tabs */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.line}`, marginBottom: 12 }}>
            {[["chain", "CHAIN + GREEKS"], ["surface", "VOL SURFACE"], ["skew", "TERM / SKEW"], ["pricing", "PRICING LAB"], ["builder", "STRATEGY BUILDER"], ["calendar", "ECON CALENDAR"]].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={tabBtn(tab === k)}>{l}</button>
            ))}
          </div>

          {/* expiry + type controls (chain/skew/builder) */}
          {(tab === "chain" || tab === "skew" || tab === "builder") && (
            <div style={{ display: "flex", gap: 5, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
              {EXPIRIES.map((e, i) => (
                <button key={e.label} onClick={() => setExpIdx(i)} style={btn(expIdx === i, C.violet)}>{e.label}</button>
              ))}
              {tab === "chain" && (
                <>
                  <div style={{ flex: 1 }} />
                  {["call", "put"].map((tp) => (
                    <button key={tp} onClick={() => setChainType(tp)} style={btn(chainType === tp, tp === "call" ? C.green : C.red)}>{tp.toUpperCase()}</button>
                  ))}
                </>
              )}
            </div>
          )}

          {tab === "chain" && <ChainTable chain={chain} type={chainType} />}
          {tab === "surface" && <Surface surface={surface} cols={moneynessCols} />}
          {tab === "skew" && <TermSkew sel={sel} T={T} expLabel={EXPIRIES[expIdx].label} />}
          {tab === "pricing" && <PricingLab sel={sel} S={S} />}
          {tab === "builder" && (
            <StrategyBuilder
              legs={legs} addLeg={addLeg} updateLeg={updateLeg} removeLeg={removeLeg}
              payoffData={payoffData} S={S} selSym={selSym}
            />
          )}
          {tab === "calendar" && <Calendar calendar={calendar} />}
        </div>

        {/* ════ RIGHT: flow ════ */}
        <div style={{ borderLeft: `1px solid ${C.line}`, padding: 10, maxHeight: 760, overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Label>UNUSUAL FLOW</Label>
            <span style={{ fontSize: 9, color: C.red }}>● LIVE</span>
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {[["all", "ALL"], ["calls", "C"], ["puts", "P"]].map(([k, l]) => (
              <button key={k} onClick={() => setFlowFilter(k)} style={btn(flowFilter === k)}>{l}</button>
            ))}
          </div>
          {filteredFlow.length === 0 && <div style={{ color: C.dim, fontSize: 11 }}>scanning order flow…</div>}
          {filteredFlow.map((f) => (
            <div key={f.id} onClick={() => setSelSym(f.sym)} style={{ padding: "7px 0", borderBottom: `1px solid ${C.panel}`, fontSize: 11, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700 }}>{f.sym}</span>
                <span style={{ color: f.side === "C" ? C.green : C.red, fontWeight: 700 }}>
                  {f.side === "C" ? "CALL" : "PUT"} ${f.prem}k
                </span>
              </div>
              <div style={{ color: C.dim, fontSize: 10, marginTop: 2 }}>
                ${f.strike} · {f.exp} · @{f.aggressive}
                {f.sweep && <span style={{ color: C.amber }}> · SWEEP</span>}
              </div>
              <div style={{ color: C.dim, fontSize: 9 }}>{f.ago}s ago</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${C.line}`, padding: "8px 16px", fontSize: 10, color: C.dim, display: "flex", justifyContent: "space-between" }}>
        <span>PROTOTYPE · SIMULATED DATA · REAL BLACK–SCHOLES + IV ENGINE · NOT INVESTMENT ADVICE</span>
        <span>EU/IT · educational</span>
      </div>
      </div>
    </>
  );
}

// ─────────────────────── sub-components ───────────────────────

function ChainTable({ chain, type }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ color: C.dim, fontSize: 10, textAlign: "right" }}>
          <th style={{ textAlign: "left", padding: "4px 6px" }}>STRIKE</th>
          <th style={th()}>IV%</th><th style={th()}>PRICE</th><th style={th()}>Δ</th>
          <th style={th()}>Γ</th><th style={th()}>Θ</th><th style={th()}>V</th>
          <th style={th()}>OI</th><th style={th()}>VOL</th>
        </tr>
      </thead>
      <tbody>
        {chain.map((row) => {
          const g = type === "call" ? row.call : row.put;
          return (
            <tr key={row.K} style={{ textAlign: "right", background: row.atm ? C.panel2 : "transparent", borderBottom: `1px solid ${C.panel}` }}>
              <td style={{ textAlign: "left", padding: "5px 6px", fontWeight: row.atm ? 700 : 400, color: row.atm ? C.cyan : C.txt }}>
                {row.K}{row.atm && <span style={{ fontSize: 8, color: C.dim }}> ATM</span>}
              </td>
              <td style={{ ...td(), color: ivColor(row.iv * 100) }}>{(row.iv * 100).toFixed(1)}</td>
              <td style={{ ...td(), fontWeight: 700 }}>{g.price.toFixed(2)}</td>
              <td style={{ ...td(), color: C.dim }}>{g.delta.toFixed(3)}</td>
              <td style={{ ...td(), color: C.dim }}>{g.gamma.toFixed(4)}</td>
              <td style={{ ...td(), color: C.red }}>{g.theta.toFixed(3)}</td>
              <td style={{ ...td(), color: C.dim }}>{g.vega.toFixed(3)}</td>
              <td style={{ ...td(), color: C.dim }}>{row.oi.toLocaleString()}</td>
              <td style={{ ...td(), color: row.vol > row.oi ? C.amber : C.dim }}>{row.vol.toLocaleString()}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Surface({ surface, cols }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.dim, marginBottom: 8 }}>IMPLIED VOL (%) — rows: expiry · cols: moneyness K/S</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: C.dim, fontSize: 10 }}>
            <th style={{ textAlign: "left", padding: "4px 6px" }}>EXP</th>
            {cols.map((m) => <th key={m} style={{ padding: "4px 6px", textAlign: "center" }}>{m.toFixed(2)}</th>)}
          </tr>
        </thead>
        <tbody>
          {surface.map((r) => (
            <tr key={r.label}>
              <td style={{ padding: "4px 6px", color: C.dim }}>{r.label}</td>
              {r.cells.map((c, i) => {
                const intensity = Math.min(1, (c - 10) / 65);
                return (
                  <td key={i} style={{ padding: "9px 6px", textAlign: "center", fontWeight: 700,
                    background: `rgba(255,91,110,${intensity * 0.6})`,
                    color: intensity > 0.5 ? "#fff" : C.txt, border: `1px solid ${C.bg}` }}>
                    {c.toFixed(1)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
        Hotter = higher IV. Read the put-side skew (left columns richer) and the term premium building as expiry extends. An inverted top row (front &gt; back) flags an imminent event.
      </div>
    </div>
  );
}

function TermSkew({ sel, T, expLabel }) {
  const term = EXPIRIES.map((e) => ({ label: e.label, iv: syntheticIV(sel.baseVol, 1, e.T) * 100 }));
  const ms = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15];
  const skew = ms.map((m) => syntheticIV(sel.baseVol, m, T) * 100);
  return (
    <div>
      <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>ATM TERM STRUCTURE</div>
      <LineChart pts={term.map((t) => t.iv)} labels={term.map((t) => t.label)} color={C.violet} h={150} />
      <div style={{ fontSize: 10, color: C.dim, margin: "14px 0 6px" }}>PUT/CALL SKEW @ {expLabel}</div>
      <SkewChart vals={skew} labels={ms.map((m) => m.toFixed(2))} />
      <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
        Term: upward slope = normal (longer-dated richer). Inversion = event/earnings vol in the front. Skew: a steep left wing means the market is paying up for downside protection.
      </div>
    </div>
  );
}

function LineChart({ pts, labels, color, h = 150 }) {
  const w = 560;
  const min = Math.min(...pts) - 2, max = Math.max(...pts) + 2;
  const x = (i) => 40 + (i / (pts.length - 1)) * (w - 80);
  const y = (v) => h - 30 - ((v - min) / (max - min)) * (h - 50);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }}>
      {[0, 0.5, 1].map((f) => <line key={f} x1="40" x2={w - 40} y1={20 + f * (h - 50)} y2={20 + f * (h - 50)} stroke={C.line} />)}
      <polyline points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={color} strokeWidth="2" />
      {pts.map((v, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r="3.5" fill={C.cyan} />
          <text x={x(i)} y={h - 8} fill={C.dim} fontSize="9" textAnchor="middle">{labels[i]}</text>
          <text x={x(i)} y={y(v) - 8} fill={C.txt} fontSize="9" textAnchor="middle">{v.toFixed(0)}</text>
        </g>
      ))}
    </svg>
  );
}

function SkewChart({ vals, labels }) {
  const w = 560, h = 140;
  const min = Math.min(...vals) - 2, max = Math.max(...vals) + 2;
  const x = (i) => 40 + (i / (vals.length - 1)) * (w - 80);
  const y = (v) => h - 25 - ((v - min) / (max - min)) * (h - 45);
  const atmIdx = 3;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }}>
      <line x1={x(atmIdx)} x2={x(atmIdx)} y1="8" y2={h - 25} stroke={C.line} strokeDasharray="3 3" />
      <text x={x(atmIdx)} y={h - 8} fill={C.cyan} fontSize="9" textAnchor="middle">ATM</text>
      <polyline points={vals.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={C.amber} strokeWidth="2" />
      {vals.map((v, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r="3" fill={i < atmIdx ? C.red : i > atmIdx ? C.green : C.cyan} />
          {i !== atmIdx && <text x={x(i)} y={h - 8} fill={C.dim} fontSize="8" textAnchor="middle">{labels[i]}</text>}
        </g>
      ))}
    </svg>
  );
}

function StrategyBuilder({ legs, addLeg, updateLeg, removeLeg, payoffData, S, selSym }) {
  return (
    <div>
      <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap" }}>
        <button onClick={() => addLeg("call", 1)} style={addBtn(C.green)}>+ LONG CALL</button>
        <button onClick={() => addLeg("call", -1)} style={addBtn(C.red)}>− SHORT CALL</button>
        <button onClick={() => addLeg("put", 1)} style={addBtn(C.green)}>+ LONG PUT</button>
        <button onClick={() => addLeg("put", -1)} style={addBtn(C.red)}>− SHORT PUT</button>
        <button onClick={() => addLeg("stock", 1)} style={addBtn(C.cyan)}>+ STOCK</button>
      </div>

      {legs.length === 0 && (
        <div style={{ color: C.dim, fontSize: 12, padding: "20px 0", textAlign: "center" }}>
          Add legs to build a strategy. Try: long call + long put = straddle · short put + short call = strangle · long+short call = vertical spread.
        </div>
      )}

      {legs.length > 0 && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginBottom: 14 }}>
            <thead>
              <tr style={{ color: C.dim, fontSize: 9 }}>
                <th style={{ textAlign: "left", padding: "3px 5px" }}>LEG</th>
                <th style={th()}>QTY</th><th style={th()}>STRIKE</th><th style={th()}>PREMIUM</th><th></th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => (
                <tr key={l.id} style={{ borderBottom: `1px solid ${C.panel}` }}>
                  <td style={{ padding: "5px", color: l.qty > 0 ? C.green : C.red, fontWeight: 700 }}>
                    {l.qty > 0 ? "LONG" : "SHORT"} {l.type.toUpperCase()}
                  </td>
                  <td style={td()}><NumIn value={Math.abs(l.qty)} onChange={(v) => updateLeg(l.id, "qty", (l.qty < 0 ? -1 : 1) * Math.max(1, v))} /></td>
                  <td style={td()}>{l.type === "stock" ? "—" : <NumIn value={l.strike} onChange={(v) => updateLeg(l.id, "strike", v)} />}</td>
                  <td style={td()}><NumIn value={l.premium} onChange={(v) => updateLeg(l.id, "premium", v)} step="0.01" /></td>
                  <td style={{ ...td(), textAlign: "right" }}><button onClick={() => removeLeg(l.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          {payoffData && (
            <>
              <PayoffChart payoffData={payoffData} S={S} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 12 }}>
                <Stat label="NET" value={`$${payoffData.net.toFixed(0)}`} color={payoffData.net >= 0 ? C.green : C.red} sub={payoffData.net >= 0 ? "credit" : "debit"} />
                <Stat label="MAX PROFIT" value={isFinite(payoffData.maxProfit) ? `$${payoffData.maxProfit.toFixed(0)}` : "∞"} color={C.green} />
                <Stat label="MAX LOSS" value={`$${payoffData.maxLoss.toFixed(0)}`} color={C.red} />
                <Stat label="BREAKEVEN" value={payoffData.bes.map((b) => b.toFixed(0)).join(" / ") || "—"} color={C.cyan} />
              </div>
              <div style={{ marginTop: 12, padding: 10, background: C.panel, border: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 9, color: C.dim, marginBottom: 6 }}>NET POSITION GREEKS @ spot ${fmt(S)}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, fontSize: 12 }}>
                  <GreekStat label="Δ Delta" value={payoffData.greeks.delta.toFixed(1)} />
                  <GreekStat label="Γ Gamma" value={payoffData.greeks.gamma.toFixed(2)} />
                  <GreekStat label="Θ Theta" value={payoffData.greeks.theta.toFixed(1)} color={C.red} />
                  <GreekStat label="V Vega" value={payoffData.greeks.vega.toFixed(1)} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PayoffChart({ payoffData, S }) {
  const { payoff, bes } = payoffData;
  const w = 560, h = 220;
  const pnls = payoff.map((p) => p.pnl);
  const Ss = payoff.map((p) => p.S);
  const minP = Math.min(...pnls), maxP = Math.max(...pnls);
  const minS = Math.min(...Ss), maxS = Math.max(...Ss);
  const x = (s) => 40 + ((s - minS) / (maxS - minS)) * (w - 60);
  const y = (p) => h - 25 - ((p - minP) / (maxP - minP)) * (h - 45);
  const zeroY = y(0);
  const path = payoff.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.S)},${y(p.pnl)}`).join(" ");
  const areaUp = `${path} L${x(maxS)},${zeroY} L${x(minS)},${zeroY} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h }}>
      <defs>
        <clipPath id="above"><rect x="0" y="0" width={w} height={zeroY} /></clipPath>
        <clipPath id="below"><rect x="0" y={zeroY} width={w} height={h - zeroY} /></clipPath>
      </defs>
      <path d={areaUp} fill={C.green} opacity="0.12" clipPath="url(#above)" />
      <path d={areaUp} fill={C.red} opacity="0.12" clipPath="url(#below)" />
      <line x1="40" x2={w - 20} y1={zeroY} y2={zeroY} stroke={C.dim} strokeDasharray="2 2" />
      <line x1={x(S)} x2={x(S)} y1="10" y2={h - 25} stroke={C.cyan} strokeDasharray="3 3" />
      <text x={x(S)} y="18" fill={C.cyan} fontSize="9" textAnchor="middle">SPOT {S.toFixed(0)}</text>
      <path d={path} fill="none" stroke={C.violet} strokeWidth="2" />
      {bes.map((b, i) => (
        <g key={i}>
          <circle cx={x(b)} cy={zeroY} r="3.5" fill={C.amber} />
          <text x={x(b)} y={h - 8} fill={C.amber} fontSize="9" textAnchor="middle">{b.toFixed(0)}</text>
        </g>
      ))}
      <text x="42" y={y(maxP) + 4} fill={C.green} fontSize="9">+${maxP.toFixed(0)}</text>
      <text x="42" y={y(minP) - 2} fill={C.red} fontSize="9">${minP.toFixed(0)}</text>
    </svg>
  );
}

function Calendar({ calendar }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.dim, marginBottom: 10 }}>
        MACRO & EARNINGS CALENDAR — impact rated by expected vol effect. Tap-relevant tickers shown.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8 }}>
        {calendar.map((d) => (
          <div key={d.day} style={{ background: d.isToday ? C.panel2 : C.panel, border: `1px solid ${d.isToday ? C.cyan : C.line}`, padding: 8, minHeight: 180 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, color: d.isToday ? C.cyan : C.txt, fontSize: 11 }}>{d.day}</span>
              <span style={{ fontSize: 9, color: C.dim }}>{d.dateLabel}</span>
            </div>
            {d.events.length === 0 && <div style={{ fontSize: 10, color: C.dim }}>—</div>}
            {d.events.map((e, i) => (
              <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < d.events.length - 1 ? `1px solid ${C.line}` : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 9, color: C.dim }}>{e.time} {e.tz}</span>
                  <span style={{ fontSize: 9, color: e.impact >= 3 ? C.red : e.impact === 2 ? C.amber : C.dim }}>{impactDots(e.impact)}</span>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, margin: "2px 0", lineHeight: 1.3 }}>{e.name}</div>
                <div style={{ fontSize: 9, color: C.dim }}>cons {e.cons} · prev {e.prev}</div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 3 }}>
                  {e.affects.slice(0, 3).map((a) => (
                    <span key={a} style={{ fontSize: 8, color: C.violet, border: `1px solid ${C.line}`, padding: "1px 4px" }}>{a}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════ PRICING LAB ═══════════════
// Manual pricing with full control over every input. Compare a MARKET IV
// against your own THEORETICAL vol to flag rich/cheap mismatches.
const RATE_PRESETS = [
  { label: "ESTR €", v: 0.0265 },
  { label: "SOFR $", v: 0.0433 },
  { label: "SONIA £", v: 0.0470 },
  { label: "BoJ ¥", v: 0.0050 },
  { label: "SNB ₣", v: 0.0125 },
];

function PricingLab({ sel, S: spotLive }) {
  const [S, setS] = useState(() => +spotLive.toFixed(2));
  const [K, setK] = useState(() => Math.round(spotLive));
  const [days, setDays] = useState(30);
  const [r, setR] = useState(0.0433);
  const [q, setQ] = useState(0);
  const [type, setType] = useState("call");
  const [marketIV, setMarketIV] = useState(() => +(syntheticIV(sel.baseVol, 1, 30 / 365) * 100).toFixed(1));
  const [theoIV, setTheoIV] = useState(() => +(syntheticIV(sel.baseVol, 1, 30 / 365) * 100).toFixed(1));
  const [marketPrice, setMarketPrice] = useState(null);

  const T = days / 365;

  // price under each vol
  const mkt = useMemo(() => bs(S, K, T, r, marketIV / 100, type, q), [S, K, T, r, marketIV, type, q]);
  const theo = useMemo(() => bs(S, K, T, r, theoIV / 100, type, q), [S, K, T, r, theoIV, type, q]);

  // if user typed a market price, back out its implied vol
  const backedOutIV = useMemo(() => {
    if (!marketPrice || marketPrice <= 0) return null;
    const iv = impliedVol(marketPrice, S, K, T, r, type, q);
    return iv ? iv * 100 : null;
  }, [marketPrice, S, K, T, r, type, q]);

  // mismatch: theoretical price vs market price (priced at market IV)
  const priceDiff = theo.price - mkt.price;
  const volDiff = theoIV - marketIV;
  const richCheap = priceDiff > 0.01 ? "UNDERPRICED" : priceDiff < -0.01 ? "OVERPRICED" : "FAIR";
  const rcColor = richCheap === "UNDERPRICED" ? C.green : richCheap === "OVERPRICED" ? C.red : C.dim;

  const inRow = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 };
  const lbl = { fontSize: 10, color: C.dim, letterSpacing: "0.08em" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 18 }}>
      {/* ── inputs ── */}
      <div>
        <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.16em", marginBottom: 10, borderLeft: `2px solid ${C.cyan}`, paddingLeft: 7 }}>INPUTS</div>

        <div style={inRow}><span style={lbl}>SPOT (S)</span><PriceIn value={S} onChange={setS} step="0.01" /></div>
        <div style={inRow}><span style={lbl}>STRIKE (K)</span><PriceIn value={K} onChange={setK} step="0.5" /></div>
        <div style={inRow}><span style={lbl}>DAYS TO EXP</span><PriceIn value={days} onChange={setDays} step="1" /></div>
        <div style={{ fontSize: 9, color: C.dim, textAlign: "right", marginTop: -4, marginBottom: 8 }}>T = {T.toFixed(4)} yr</div>

        {/* risk-free with presets */}
        <div style={{ ...inRow, marginBottom: 4 }}><span style={lbl}>RISK-FREE r (%)</span><PriceIn value={+(r * 100).toFixed(3)} onChange={(v) => setR(v / 100)} step="0.01" /></div>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 10 }}>
          {RATE_PRESETS.map((p) => (
            <button key={p.label} onClick={() => setR(p.v)} style={{
              background: Math.abs(r - p.v) < 1e-6 ? C.cyan : "transparent",
              color: Math.abs(r - p.v) < 1e-6 ? C.bg : C.dim,
              border: `1px solid ${C.line}`, padding: "2px 6px", fontSize: 9,
              fontFamily: FONT, cursor: "pointer", fontWeight: 700,
            }}>{p.label} {(p.v * 100).toFixed(2)}</button>
          ))}
        </div>

        <div style={inRow}><span style={lbl}>DIV YIELD q (%)</span><PriceIn value={+(q * 100).toFixed(2)} onChange={(v) => setQ(v / 100)} step="0.1" /></div>

        <div style={{ display: "flex", gap: 5, margin: "8px 0 14px" }}>
          {["call", "put"].map((tp) => (
            <button key={tp} onClick={() => setType(tp)} style={{
              flex: 1, background: type === tp ? (tp === "call" ? C.green : C.red) : "transparent",
              color: type === tp ? C.bg : C.dim, border: `1px solid ${C.line}`,
              padding: "5px 0", fontSize: 11, fontFamily: FONT, cursor: "pointer", fontWeight: 700,
            }}>{tp.toUpperCase()}</button>
          ))}
        </div>

        {/* the two vols */}
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, padding: 10, marginBottom: 10 }}>
          <div style={{ ...inRow, marginBottom: 6 }}>
            <span style={{ ...lbl, color: C.amber }}>● MARKET IV (%)</span>
            <PriceIn value={marketIV} onChange={setMarketIV} step="0.5" />
          </div>
          <div style={inRow}>
            <span style={{ ...lbl, color: C.violet }}>● YOUR VOL (%)</span>
            <PriceIn value={theoIV} onChange={setTheoIV} step="0.5" />
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>
            spread {volDiff >= 0 ? "+" : ""}{volDiff.toFixed(1)} vol pts
          </div>
        </div>

        {/* reverse: price → IV */}
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, padding: 10 }}>
          <div style={inRow}>
            <span style={lbl}>MKT PRICE →</span>
            <PriceIn value={marketPrice ?? ""} onChange={setMarketPrice} step="0.01" placeholder="—" />
          </div>
          <div style={{ fontSize: 11, color: backedOutIV ? C.cyan : C.dim }}>
            backed-out IV: {backedOutIV ? backedOutIV.toFixed(2) + "%" : "enter a price"}
          </div>
        </div>
      </div>

      {/* ── outputs ── */}
      <div>
        <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.16em", marginBottom: 10, borderLeft: `2px solid ${C.cyan}`, paddingLeft: 7 }}>VALUATION</div>

        {/* mismatch banner */}
        <div style={{ background: C.panel2, border: `1px solid ${rcColor}`, padding: "12px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 9, color: C.dim }}>MARKET vs YOUR FAIR VALUE</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: rcColor }}>{richCheap}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: C.dim }}>edge</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: rcColor }}>
              {priceDiff >= 0 ? "+" : ""}{priceDiff.toFixed(3)}
            </div>
            <div style={{ fontSize: 9, color: C.dim }}>{mkt.price > 0 ? ((priceDiff / mkt.price) * 100).toFixed(1) : "0"}%</div>
          </div>
        </div>

        {/* two-column price+greeks comparison */}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: C.dim, fontSize: 10 }}>
              <th style={{ textAlign: "left", padding: "5px 8px" }}>METRIC</th>
              <th style={{ textAlign: "right", padding: "5px 8px", color: C.amber }}>@ MARKET {marketIV.toFixed(1)}%</th>
              <th style={{ textAlign: "right", padding: "5px 8px", color: C.violet }}>@ YOUR {theoIV.toFixed(1)}%</th>
              <th style={{ textAlign: "right", padding: "5px 8px" }}>Δ</th>
            </tr>
          </thead>
          <tbody>
            <PriceRow label="Price" m={mkt.price} t={theo.price} d={3} highlight />
            <PriceRow label="Δ Delta" m={mkt.delta} t={theo.delta} d={4} />
            <PriceRow label="Γ Gamma" m={mkt.gamma} t={theo.gamma} d={5} />
            <PriceRow label="Θ Theta /day" m={mkt.theta} t={theo.theta} d={4} />
            <PriceRow label="V Vega /pt" m={mkt.vega} t={theo.vega} d={4} />
            <PriceRow label="ρ Rho" m={mkt.rho} t={theo.rho} d={4} />
            <PriceRow label="Vanna" m={mkt.vanna} t={theo.vanna} d={5} />
            <PriceRow label="Volga" m={mkt.volga} t={theo.volga} d={4} />
          </tbody>
        </table>

        <div style={{ fontSize: 10, color: C.dim, marginTop: 14, lineHeight: 1.6, background: C.panel, padding: 10, border: `1px solid ${C.line}` }}>
          <b style={{ color: C.txt }}>How to read it:</b> price the option at the market's implied vol and again at your own volatility estimate.
          If your vol is higher, you think the option is worth more than the screen — it's <span style={{ color: C.green }}>UNDERPRICED</span> and the edge is positive.
          Lower vol → <span style={{ color: C.red }}>OVERPRICED</span>. The reverse box backs out the IV embedded in any market price via Newton–Raphson, so you can compare it against your fair vol directly.
        </div>
      </div>
    </div>
  );
}

function PriceRow({ label, m, t, d, highlight }) {
  const diff = t - m;
  return (
    <tr style={{ borderBottom: `1px solid ${C.panel}`, background: highlight ? C.panel : "transparent" }}>
      <td style={{ padding: "6px 8px", color: highlight ? C.txt : C.dim, fontWeight: highlight ? 700 : 400 }}>{label}</td>
      <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: highlight ? 700 : 400 }}>{m.toFixed(d)}</td>
      <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: highlight ? 700 : 400 }}>{t.toFixed(d)}</td>
      <td style={{ padding: "6px 8px", textAlign: "right", color: Math.abs(diff) < 1e-9 ? C.dim : diff > 0 ? C.green : C.red }}>
        {diff >= 0 ? "+" : ""}{diff.toFixed(d)}
      </td>
    </tr>
  );
}

function PriceIn({ value, onChange, step = "1", placeholder }) {
  return (
    <input
      type="number" value={value} step={step} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? null : parseFloat(e.target.value))}
      style={{ width: 90, background: C.bg, color: C.txt, border: `1px solid ${C.line}`,
        fontSize: 13, fontFamily: FONT, padding: "4px 6px", textAlign: "right" }}
    />
  );
}

// ─────────── tiny UI atoms ───────────
const Label = ({ children }) => (
  <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.16em", marginBottom: 8, borderLeft: `2px solid ${C.cyan}`, paddingLeft: 7 }}>{children}</div>
);
const btn = (active, col = C.cyan) => ({
  flex: 1, background: active ? col : "transparent", color: active ? C.bg : C.dim,
  border: `1px solid ${C.line}`, padding: "4px 8px", fontSize: 10, fontFamily: "inherit",
  cursor: "pointer", fontWeight: 700,
});
const tabBtn = (active) => ({
  background: "transparent", color: active ? C.cyan : C.dim, border: "none",
  borderBottom: `2px solid ${active ? C.cyan : "transparent"}`, padding: "7px 12px",
  fontSize: 10.5, fontFamily: "inherit", cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap",
});
const addBtn = (col) => ({
  background: "transparent", color: col, border: `1px solid ${col}`, padding: "5px 9px",
  fontSize: 10, fontFamily: "inherit", cursor: "pointer", fontWeight: 700,
});
const tag = () => ({ marginLeft: 8, fontSize: 9, color: C.dim, border: `1px solid ${C.line}`, padding: "2px 6px" });
const th = () => ({ padding: "4px 6px" });
const td = () => ({ padding: "5px 6px" });

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{
      flex: 1, background: C.panel, color: C.txt, border: `1px solid ${C.line}`,
      fontSize: 9, fontFamily: "inherit", padding: "3px", cursor: "pointer",
    }}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function NumIn({ value, onChange, step = "1" }) {
  return (
    <input type="number" value={value} step={step} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      style={{ width: 58, background: C.bg, color: C.txt, border: `1px solid ${C.line}`, fontSize: 11, fontFamily: "inherit", padding: "2px 4px", textAlign: "right" }} />
  );
}
function Stat({ label, value, color, sub }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, padding: "7px 9px" }}>
      <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.1em" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 8, color: C.dim }}>{sub}</div>}
    </div>
  );
}
function GreekStat({ label, value, color = C.txt }) {
  return (
    <div>
      <div style={{ fontSize: 8, color: C.dim }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
