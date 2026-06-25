// ════════════════════════════════════════════════════════════════════
// api/quotes.js — EXAMPLE Vercel serverless function (live-data starter)
// ────────────────────────────────────────────────────────────────────
// This is a template showing the server-side pattern: the API key lives
// here (in an env var), never in the browser. The frontend calls
// /api/quotes?symbols=NVDA,AAPL and gets back clean JSON.
//
// To activate: set POLYGON_API_KEY in Vercel project settings, then have
// dataProvider.getScreener() fetch('/api/quotes?...') instead of using
// the synthetic UNIVERSE spots.
//
// Swap Polygon for Tradier/Twelve Data by changing the fetch URL + parse.
// ════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  const symbols = (req.query.symbols || "").split(",").filter(Boolean);
  if (symbols.length === 0) {
    return res.status(400).json({ error: "no symbols" });
  }

  const KEY = process.env.POLYGON_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: "POLYGON_API_KEY not set" });
  }

  try {
    const results = await Promise.all(
      symbols.map(async (sym) => {
        // Polygon previous-close endpoint (works on free tier, delayed)
        const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
          sym
        )}/prev?adjusted=true&apiKey=${KEY}`;
        const r = await fetch(url);
        const j = await r.json();
        const px = j?.results?.[0]?.c ?? null; // close
        return [sym, px];
      })
    );

    // cache at the edge for 30s to respect rate limits
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(Object.fromEntries(results));
  } catch (e) {
    return res.status(502).json({ error: "upstream failed", detail: String(e) });
  }
}
