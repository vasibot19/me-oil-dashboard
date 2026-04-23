// Vercel serverless function: proxies Yahoo Finance chart data for a ticker.
// Handles CORS + required User-Agent that Yahoo blocks without.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

  const symbol = (req.query.symbol || "BZ=F").toString();
  const range = (req.query.range || "1d").toString();
  const interval = (req.query.interval || (range === "1d" ? "5m" : "30m")).toString();

  // Whitelist to avoid open proxy abuse
  const allowed = new Set(["BZ=F", "CL=F"]);
  if (!allowed.has(symbol)) {
    res.status(400).json({ error: "symbol not allowed" });
    return;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
      },
    });

    if (!r.ok) {
      res.status(r.status).json({ error: `yahoo ${r.status}` });
      return;
    }

    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      res.status(502).json({ error: "unexpected yahoo shape", raw: data });
      return;
    }

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    // Build a cleaned series
    const series = timestamps
      .map((t, i) => ({ t: t * 1000, c: closes[i] }))
      .filter((p) => p.c != null);

    const last = series.length ? series[series.length - 1].c : meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
    const change = last != null && prevClose != null ? last - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;

    res.status(200).json({
      symbol,
      currency: meta.currency || "USD",
      last,
      prevClose,
      change,
      changePct,
      marketTime: (meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000,
      range,
      interval,
      series,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
