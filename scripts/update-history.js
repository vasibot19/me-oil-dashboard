// Fetches intraday + daily price history from Yahoo Finance for our tickers
// and writes data/history.json. Run by .github/workflows/update-history.yml
// every ~15 minutes from a GitHub-hosted runner (no Vercel IP rate-limiting).

import fs from "fs/promises";

const SYMBOLS = [
  "BZ=F",   // Brent
  "CL=F",   // WTI
  "GC=F",   // Gold (XAUUSD proxy)
];

const RANGES = [
  { range: "1d",  interval: "5m"  }, // last 24h, 5-min bars
  { range: "5d",  interval: "30m" }, // last 5 trading days
  { range: "1mo", interval: "1d"  }, // last ~30 days, daily closes
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchYahoo(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`yahoo ${r.status} ${symbol} ${range}/${interval}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`no chart data ${symbol} ${range}`);
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const meta = result.meta || {};
  const series = ts
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter((p) => p.c != null);
  return {
    series,
    last: meta.regularMarketPrice ?? series[series.length - 1]?.c ?? null,
    prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency || "USD",
  };
}

async function main() {
  const out = { updated: Date.now(), symbols: {} };

  for (const sym of SYMBOLS) {
    out.symbols[sym] = { ranges: {}, last: null, prevClose: null, err: null };
    try {
      for (const { range, interval } of RANGES) {
        const got = await fetchYahoo(sym, range, interval);
        out.symbols[sym].ranges[range] = got.series;
        if (out.symbols[sym].last == null) out.symbols[sym].last = got.last;
        if (out.symbols[sym].prevClose == null) out.symbols[sym].prevClose = got.prevClose;
        out.symbols[sym].currency = got.currency;
        console.log(`${sym} ${range}: ${got.series.length} pts (last=${got.last})`);
      }
    } catch (e) {
      console.error(`${sym}: ${e.message}`);
      out.symbols[sym].err = e.message;
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/history.json", JSON.stringify(out));
  console.log("wrote data/history.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
