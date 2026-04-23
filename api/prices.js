// Vercel serverless function: oil price proxy.
// Yahoo Finance API + Yahoo HTML scrape (less rate-limited) + Stooq.
// Returns { last, change, changePct, prevClose, series } where series may be empty if only HTML scrape worked.

const STOOQ_TICKER = { "BZ=F": "cb.f", "CL=F": "cl.f" };

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

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

async function tryYahooHtml(symbol, diag) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
  try {
    const r = await fetch(url, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    diag.push({ src: "yahoo-html", status: r.status });
    if (!r.ok) return null;
    const html = await r.text();
    diag.push({ src: "yahoo-html", htmlLen: html.length });
    // Yahoo's quote page mentions many tickers (related, trending). Scope our regex to the
    // block right after the symbol identifier so we extract THIS ticker's prices, not someone else's.
    const symIdx = html.indexOf(`"symbol":"${symbol}"`);
    if (symIdx < 0) {
      // Without finding the symbol marker we can't trust prices to belong to this ticker,
      // so bail. Yahoo's layout sometimes serves a generic page or detects bots.
      diag.push({ src: "yahoo-html", note: "symbol not found in HTML; abandoning scrape" });
      return null;
    }
    const scope = html.slice(symIdx, symIdx + 8000);
    diag.push({ src: "yahoo-html", symIdx, scopeLen: scope.length });
    const priceMatch = scope.match(/"regularMarketPrice":\s*\{?\s*"raw":\s*(-?[\d.]+)/);
    const prevMatch = scope.match(/"regularMarketPreviousClose":\s*\{?\s*"raw":\s*(-?[\d.]+)/);
    const chgMatch = scope.match(/"regularMarketChange":\s*\{?\s*"raw":\s*(-?[\d.]+)/);
    const chgPctMatch = scope.match(/"regularMarketChangePercent":\s*\{?\s*"raw":\s*(-?[\d.]+)/);
    const timeMatch = scope.match(/"regularMarketTime":\s*\{?\s*"raw":\s*(\d+)/);
    const currencyMatch = scope.match(/"currency":\s*"([A-Z]{3})"/);
    if (!priceMatch) {
      diag.push({ src: "yahoo-html", note: "no price match", first: html.slice(0, 200) });
      return null;
    }
    const last = parseFloat(priceMatch[1]);
    const prevClose = prevMatch ? parseFloat(prevMatch[1]) : null;
    const change = chgMatch ? parseFloat(chgMatch[1]) : (prevClose != null ? last - prevClose : null);
    const changePct = chgPctMatch ? parseFloat(chgPctMatch[1]) : (prevClose ? (change / prevClose) * 100 : null);
    const marketTime = timeMatch ? parseInt(timeMatch[1], 10) * 1000 : Date.now();
    return {
      source: "yahoo-html",
      symbol,
      currency: currencyMatch ? currencyMatch[1] : "USD",
      last,
      prevClose,
      change,
      changePct,
      marketTime,
      range: "1d",
      interval: "snapshot",
      series: [], // no historical series from HTML scrape
    };
  } catch (e) {
    diag.push({ src: "yahoo-html", err: String(e) });
    return null;
  }
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
  const url = `https://stooq.com/q/d/l/?s=${t}&i=d`;
  try {
    const r = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Accept: "text/csv,*/*", Referer: "https://stooq.com/" },
    });
    const text = await r.text();
    diag.push({ src: "stooq", status: r.status, len: text.length });
    if (!r.ok || !text.length) return null;
    const all = parseStooqHistory(text);
    if (!all.length) return null;
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
    diag.push({ src: "stooq", err: String(e) });
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");

  const symbol = (req.query.symbol || "BZ=F").toString();
  const range = (req.query.range || "1d").toString();
  const interval = (req.query.interval || (range === "1d" ? "5m" : "30m")).toString();
  const debug = "debug" in req.query;

  if (!STOOQ_TICKER[symbol]) {
    res.status(400).json({ error: "symbol not allowed" });
    return;
  }

  const diag = [];

  // Run Yahoo API + Yahoo HTML in parallel for speed; combine results.
  const [api, html, stooq] = await Promise.all([
    tryYahooApi(symbol, range, interval, diag),
    tryYahooHtml(symbol, diag),
    tryStooq(symbol, range, diag),
  ]);

  // Pick best result. API has chart series + price. HTML has price only. Stooq has daily history.
  let result =
    (api && api.last != null && api.series.length) ? api :
    (stooq && stooq.last != null) ? { ...stooq, source: stooq.source + (html?.last != null ? "+yahoo-html" : ""), last: html?.last ?? stooq.last, change: html?.change ?? stooq.change, changePct: html?.changePct ?? stooq.changePct, prevClose: html?.prevClose ?? stooq.prevClose } :
    (html && html.last != null) ? html :
    (api && api.last != null) ? api :
    null;

  if (result && result.last != null) {
    if (debug) result.diag = diag;
    res.status(200).json(result);
    return;
  }

  res.status(502).json({ error: "no source available", symbol, range, diag });
}
