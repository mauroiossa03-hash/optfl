// Minimal sanity tests for the quant engine. Run: node src/lib/quant.test.mjs
import { bs, impliedVol, strategyPayoff, breakevens, strategyNet } from "./quant.js";

let pass = 0, fail = 0;
const approx = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

const c = bs(100, 100, 1, 0.05, 0.20, "call");
t("ATM call price", approx(c.price, 10.4506, 1e-3));
t("ATM call delta", approx(c.delta, 0.6368, 1e-3));

const p = bs(100, 100, 1, 0.05, 0.20, "put");
t("put-call parity", approx(c.price - p.price, 100 - 100 * Math.exp(-0.05), 1e-4));

const px = bs(150, 155, 0.25, 0.04, 0.35, "call").price;
t("IV solver round-trip", approx(impliedVol(px, 150, 155, 0.25, 0.04, "call"), 0.35, 1e-3));

const legs = [{ type: "call", strike: 100, qty: 1, premium: 5 }, { type: "put", strike: 100, qty: 1, premium: 5 }];
const grid = Array.from({ length: 201 }, (_, i) => 50 + i);
const be = breakevens(strategyPayoff(legs, grid));
t("straddle net debit", strategyNet(legs) === -1000);
t("straddle breakevens", be.length === 2 && approx(be[0], 90, 0.5) && approx(be[1], 110, 0.5));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
