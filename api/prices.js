// Vercel serverless function: live quote proxy via CNBC's public quote API.
// Maps our internal ticker keys to CNBC symbols. CNBC isn't IP-rate-limited
// from Vercel datacenters the way Yahoo is.

const CNBC_SYMBOL = {
  // Oil & gold — primary focus
  "BZ=F":     "@LCO.1",   // Brent crude continuous
  "CL=F":     "@CL.1",    // WTI crude continuous
  "GC=F":     "@GC.1",    // COMEX gold ~ XAUUSD spot
  // Oil-focused ETFs
  "BNO":      "BNO",      // United States Brent Oil Fund (ETF)
  "USO":      "USO",      // United States Oil Fund (ETF, WTI)
  // Macro
  "EURUSD=X": "EUR=",     // EUR/USD spot
  "NDX":      ".NDX",     // NASDAQ 100 index
  "VIX":      ".VIX",     // CBOE volatility index
  // Other
  "BWET":     "BWET",     // Breakwave Dry Bulk Shipping ETF
  "BTC-USD":  "BTC.CB=",  // Bitcoin / USD spot (Coinbase)
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// Strip thousands separators before parseFloat. CNBC's "FormattedQuote" returns
// numbers as strings like "4,131.50" which parseFloat would truncate to 4.
function num(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  return parseFloat(String(v).replace(/,/g, ""));
}

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
    diag.push({ src: "cnbc", status: r.status, sym: cnbcSym });
    if (!r.ok) return null;
    const data = await r.json();
    const q = data?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q) return null;
    const last = num(q.last);
    const prevClose = num(q.previous_day_closing ?? q.previousClosePrice ?? q.last);
    const change = q.change != null ? num(q.change) : (isFinite(last - prevClose) ? last - prevClose : 0);
    const changePct = q.change_pct != null ? num(q.change_pct) : (prevClose ? (change / prevClose) * 100 : 0);
    const marketTime = q.last_time ? Date.parse(q.last_time) : Date.now();
    if (!isFinite(last)) return null;
    return {
      source: "cnbc",
      symbol,
      cnbcSymbol: cnbcSym,
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
    diag.push({ src: "cnbc", err: String(e), sym: cnbcSym });
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");

  const symbol = (req.query.symbol || "BZ=F").toString();
  const debug = "debug" in req.query;

  if (!CNBC_SYMBOL[symbol]) {
    res.status(400).json({ error: "symbol not allowed", allowed: Object.keys(CNBC_SYMBOL) });
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
