// Vercel serverless function: oil price proxy with Yahoo Finance + Stooq fallback.
// Yahoo gives intraday granularity but rate-limits Vercel IPs heavily.
// Stooq gives daily history reliably, so we use it as a robust fallback.

const STOOQ_TICKER = { "BZ=F": "cb.f", "CL=F": "cl.f" };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function tryYahooChart(symbol, range, interval) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*" },
      });
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
      const changePct =
        change != null && prevClose ? (change / prevClose) * 100 : null;
      return {
        source: "yahoo",
        symbol,
        currency: meta.currency || "USD",
        last,
        prevClose,
        change,
        changePct,
        marketTime:
          (meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000,
        range,
        interval,
        series,
      };
    } catch (_) {
      // try next host
    }
  }
  return null;
}

function parseStooqCsv(csv) {
  // Header is: Date,Open,High,Low,Close,Volume
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const t = Date.parse(cols[0] + "T16:30:00Z"); // approximate market close UTC
    const c = parseFloat(cols[4]);
    if (!isFinite(t) || !isFinite(c)) continue;
    out.push({ t, c });
  }
  return out;
}

async function tryStooq(symbol, range) {
  const t = STOOQ_TICKER[symbol];
  if (!t) return null;
  try {
    const histUrl = `https://stooq.com/q/d/l/?s=${t}&i=d`;
    const r = await fetch(histUrl, {
      headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
    });
    if (!r.ok) return null;
    const csv = await r.text();
    const all = parseStooqCsv(csv);
    if (!all.length) return null;

    const days =
      range === "1d" ? 5 :
      range === "5d" ? 10 :
      range === "1mo" ? 35 : 35;
    const cutoff = Date.now() - days * 86400000;
    const series = all.filter((p) => p.t >= cutoff);
    if (!series.length) return null;

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
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=60, stale-while-revalidate=300"
  );

  const symbol = (req.query.symbol || "BZ=F").toString();
  const range = (req.query.range || "1d").toString();
  const interval = (req.query.interval ||
    (range === "1d" ? "5m" : "30m")
  ).toString();

  if (!STOOQ_TICKER[symbol]) {
    res.status(400).json({ error: "symbol not allowed" });
    return;
  }

  // Yahoo first (fine intraday data when it works), Stooq as bulletproof backup.
  const yahoo = await tryYahooChart(symbol, range, interval);
  if (yahoo && yahoo.last != null) {
    res.status(200).json(yahoo);
    return;
  }

  const stooq = await tryStooq(symbol, range);
  if (stooq && stooq.last != null) {
    res.status(200).json(stooq);
    return;
  }

  res.status(502).json({ error: "no source available", symbol, range });
}
