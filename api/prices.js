// Vercel serverless function: oil price proxy with CNBC primary + fallbacks.
// CNBC's public quote endpoint isn't IP-rate-limited the way Yahoo and Stooq are.

const CNBC_SYMBOL = { "BZ=F": "@LCO.1", "CL=F": "@CL.1" }; // CNBC continuous futures codes
const STOOQ_TICKER = { "BZ=F": "cb.f", "CL=F": "cl.f" };

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
    if (!q) {
      diag.push({ src: "cnbc", note: "no quote in response" });
      return null;
    }
    const last = parseFloat(q.last);
    const prevClose = parseFloat(q.previous_day_closing ?? q.previousClosePrice ?? q.last);
    const change = q.change != null ? parseFloat(q.change) : (isFinite(last - prevClose) ? last - prevClose : 0);
    const changePct = q.change_pct != null ? parseFloat(q.change_pct) : (prevClose ? (change / prevClose) * 100 : 0);
    const marketTime = q.last_time ? Date.parse(q.last_time) : Date.now();
    if (!isFinite(last)) {
      diag.push({ src: "cnbc", note: "last not finite", q: JSON.stringify(q).slice(0, 300) });
      return null;
    }
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

async function tryYahooApi(symbol, range, interval, diag) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    try {
      const r = await fetch(url, {
        headers: { ...BROWSER_HEADERS, Accept: "application/json,text/plain,*/*" },
      });
      diag.push({ src: "yahoo-api:" + host, status: r.status });
      if (!r.ok) continue;
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta || {};
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const series = timestamps
        .map((t, i) => ({ t: t * 1000, c: closes[i] }))
        .filter((p) => p.c != null);
      const last = series.length ? series[series.length - 1].c : meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose;
      const change = last != null && prevClose != null ? last - prevClose : null;
      const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
      return {
        source: "yahoo-api",
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
      };
    } catch (e) {
      diag.push({ src: "yahoo-api:" + host, err: String(e) });
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  const symbol = (req.query.symbol || "BZ=F").toString();
  const range = (req.query.range || "1d").toString();
  const interval = (req.query.interval || (range === "1d" ? "5m" : "30m")).toString();
  const debug = "debug" in req.query;

  if (!STOOQ_TICKER[symbol]) {
    res.status(400).json({ error: "symbol not allowed" });
    return;
  }

  const diag = [];

  // CNBC first (simplest and most reliable when it works).
  const cnbc = await tryCnbc(symbol, diag);
  if (cnbc && cnbc.last != null) {
    if (debug) cnbc.diag = diag;
    res.status(200).json(cnbc);
    return;
  }

  // Yahoo fallback (gives us chart series when it isn't rate-limited).
  const yahoo = await tryYahooApi(symbol, range, interval, diag);
  if (yahoo && yahoo.last != null) {
    if (debug) yahoo.diag = diag;
    res.status(200).json(yahoo);
    return;
  }

  res.status(502).json({ error: "no source available", symbol, range, diag });
}
