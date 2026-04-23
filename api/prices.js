// Vercel serverless function: oil price proxy with multi-source fallback.
// Tries Yahoo, then Stooq (multiple URL formats), exposes diagnostic info on ?debug=1.

const STOOQ_TICKER = { "BZ=F": "cb.f", "CL=F": "cl.f" };

// Note: do NOT set Accept-Encoding; Node fetch doesn't auto-decompress brotli,
// and Stooq returns 200 + empty body when negotiation fails.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function tryYahoo(symbol, range, interval, diag) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    try {
      const r = await fetch(url, {
        headers: { ...BROWSER_HEADERS, Accept: "application/json,text/plain,*/*" },
      });
      diag.push({ src: "yahoo:" + host, status: r.status });
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
        source: "yahoo",
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
      diag.push({ src: "yahoo:" + host, err: String(e) });
    }
  }
  return null;
}

function parseStooqHistory(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const t = Date.parse(cols[0] + "T16:30:00Z");
    const c = parseFloat(cols[4]);
    if (!isFinite(t) || !isFinite(c)) continue;
    out.push({ t, c });
  }
  return out;
}

async function tryStooq(symbol, range, diag) {
  const t = STOOQ_TICKER[symbol];
  if (!t) return null;
  const urls = [
    `https://stooq.com/q/d/l/?s=${t}&i=d`,
    `https://stooq.com/q/d/l/?s=${t}&i=d&d1=20240101&d2=20990101`,
    `https://stooq.com/q/d/l/?i=d&s=${t}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          ...BROWSER_HEADERS,
          Accept: "text/csv,text/plain,*/*",
          Referer: "https://stooq.com/",
        },
      });
      const text = await r.text();
      diag.push({ src: "stooq:hist", url, status: r.status, len: text.length, first: text.slice(0, 80) });
      if (!r.ok) continue;
      const all = parseStooqHistory(text);
      if (!all.length) continue;
      const days = range === "1d" ? 5 : range === "5d" ? 10 : range === "1mo" ? 35 : 35;
      const cutoff = Date.now() - days * 86400000;
      let series = all.filter((p) => p.t >= cutoff);
      if (!series.length) series = all.slice(-5);
      const last = series[series.length - 1].c;
      const prevClose = series.length >= 2 ? series[series.length - 2].c : last;
      const change = last - prevClose;
      const changePct = prevClose ? (change / prevClose) * 100 : 0;
      return {
        source: "stooq",
        symbol,
        currency: "USD",
        last,
        prevClose,
        change,
        changePct,
        marketTime: series[series.length - 1].t,
        range,
        interval: "1d",
        series,
      };
    } catch (e) {
      diag.push({ src: "stooq:hist", url, err: String(e) });
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
  const yahoo = await tryYahoo(symbol, range, interval, diag);
  if (yahoo && yahoo.last != null) {
    if (debug) yahoo.diag = diag;
    res.status(200).json(yahoo);
    return;
  }

  const stooq = await tryStooq(symbol, range, diag);
  if (stooq && stooq.last != null) {
    if (debug) stooq.diag = diag;
    res.status(200).json(stooq);
    return;
  }

  res.status(502).json({ error: "no source available", symbol, range, diag });
}
