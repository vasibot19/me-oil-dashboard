// Vercel serverless function: oil + gold price proxy via CNBC public quote API.
// CNBC symbols: @LCO.1 (Brent), @CL.1 (WTI), @GC.1 (COMEX Gold ~ XAUUSD).

const CNBC_SYMBOL = {
  "BZ=F": "@LCO.1",
  "CL=F": "@CL.1",
  "GC=F": "@GC.1",  // Gold front-month, closest free proxy for XAUUSD spot
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function tryCnbc(symbol, diag) {
  const cnbcSym = CNBC_SYMBOL[symbol];
  if (!cnbcSym) return null;
  const url =
    `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(
      cnbcSym
    )}&requestMethod=extended&noform=1&fund=2&exthrs=0&output=json`;
  try {
    const r = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json,*/*", Referer: "https://www.cnbc.com/" },
    });
    diag.push({ src: "cnbc", status: r.status });
    if (!r.ok) return null;
    const data = await r.json();
    const q = data?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q) return null;
    const last = parseFloat(q.last);
    const prevClose = parseFloat(q.previous_day_closing ?? q.previousClosePrice ?? q.last);
    const change = q.change != null ? parseFloat(q.change) : (isFinite(last - prevClose) ? last - prevClose : 0);
    const changePct = q.change_pct != null ? parseFloat(q.change_pct) : (prevClose ? (change / prevClose) * 100 : 0);
    const marketTime = q.last_time ? Date.parse(q.last_time) : Date.now();
    if (!isFinite(last)) return null;
    return {
      source: "cnbc",
      symbol,
      currency: q.currencyCode || "USD",
      last,
      prevClose: isFinite(prevClose) ? prevClose : null,
      change,
      changePct,
      marketTime: isFinite(marketTime) ? marketTime : Date.now(),
      range: "1d",
      interval: "snapshot",
      series: [],
    };
  } catch (e) {
    diag.push({ src: "cnbc", err: String(e) });
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");

  const symbol = (req.query.symbol || "BZ=F").toString();
  const debug = "debug" in req.query;

  if (!CNBC_SYMBOL[symbol]) {
    res.status(400).json({ error: "symbol not allowed" });
    return;
  }

  const diag = [];
  const cnbc = await tryCnbc(symbol, diag);
  if (cnbc && cnbc.last != null) {
    if (debug) cnbc.diag = diag;
    res.status(200).json(cnbc);
    return;
  }

  res.status(502).json({ error: "no source available", symbol, diag });
}
