// Fetches daily price history from Stooq for our tickers and writes
// data/history.json. Stooq gives reliable daily-close data and doesn't
// rate-limit GitHub-runner IPs. (Yahoo Finance does — it 429s us.)
// Intraday ("1d" range) isn't available on free Stooq, so that range is left empty;
// the dashboard's "1H" toggle already provides intraday via live localStorage tape.

import fs from "fs/promises";

const STOOQ = {
  "BZ=F": "cb.f",   // Brent
  "CL=F": "cl.f",   // WTI
  "GC=F": "gc.f",   // Gold
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchStooqDaily(stooqSym) {
  const url = `https://stooq.com/q/d/l/?s=${stooqSym}&i=d`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/csv,*/*",
      Referer: "https://stooq.com/",
    },
  });
  if (!r.ok) throw new Error(`stooq ${r.status}`);
  const csv = await r.text();
  if (!csv || !csv.length) throw new Error(`stooq empty body for ${stooqSym}`);
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error(`stooq no rows for ${stooqSym}`);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    const t = Date.parse(cols[0] + "T16:30:00Z"); // approximate market close
    const c = parseFloat(cols[4]);                 // Close
    if (!isFinite(t) || !isFinite(c)) continue;
    out.push({ t, c });
  }
  if (!out.length) throw new Error(`stooq parse failed for ${stooqSym}`);
  return out;
}

async function main() {
  const out = { updated: Date.now(), symbols: {} };
  const now = Date.now();

  for (const [sym, stooqSym] of Object.entries(STOOQ)) {
    out.symbols[sym] = {
      ranges: {},
      last: null,
      prevClose: null,
      currency: "USD",
      err: null,
    };
    try {
      const series = await fetchStooqDaily(stooqSym);
      // Slice to the ranges the UI offers (1d stays empty — Stooq is daily only)
      const ranges = {
        "5d":  series.filter((p) => p.t >= now - 8 * 86400000),   // last ~7 days
        "1mo": series.filter((p) => p.t >= now - 35 * 86400000),  // last ~30 days
      };
      out.symbols[sym].ranges = ranges;
      out.symbols[sym].last = series[series.length - 1]?.c ?? null;
      out.symbols[sym].prevClose = series[series.length - 2]?.c ?? null;
      console.log(
        `${sym}: 5d=${ranges["5d"].length} 1mo=${ranges["1mo"].length} last=${out.symbols[sym].last}`
      );
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
