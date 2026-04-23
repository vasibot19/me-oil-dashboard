// Vercel serverless function: pulls Google News RSS, parses, returns JSON.
// Two buckets: a general Middle East query and an oil-focused query.
// Items from the oil-focused query (or keyword-matched elsewhere) are flagged oilImpact=true.

const GENERAL_QUERY =
  '(Iran OR Israel OR "Middle East") AND (conflict OR strike OR attack OR sanctions OR ceasefire OR escalation OR "nuclear talks")';

const OIL_QUERY =
  '(oil OR crude OR Brent OR WTI OR OPEC OR "Strait of Hormuz" OR refinery OR tanker OR pipeline OR embargo) AND (Iran OR Israel OR "Middle East" OR Saudi OR "Persian Gulf" OR Houthi)';

const OIL_KEYWORDS = [
  "oil",
  "crude",
  "brent",
  "wti",
  "opec",
  "strait of hormuz",
  "hormuz",
  "refinery",
  "tanker",
  "pipeline",
  "embargo",
  "sanction",
  "barrel",
  "saudi aramco",
  "houthi",
  "red sea",
];

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, "").trim();
}

function parseRss(xml) {
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/g;
  const matches = xml.match(itemRe) || [];
  for (const block of matches) {
    const title = stripTags((block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = stripTags((block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/) || [])[1] || "");
    const pub = stripTags((block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    const desc = stripTags((block.match(/<description\b[^>]*>([\s\S]*?)<\/description>/) || [])[1] || "");
    const src = stripTags((block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
    if (!title || !link) continue;
    items.push({ title, link, pubDate: pub, description: desc, source: src });
  }
  return items;
}

async function fetchGoogleNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`google news ${r.status}`);
  const xml = await r.text();
  return parseRss(xml);
}

function isOilImpact(text) {
  const t = (text || "").toLowerCase();
  return OIL_KEYWORDS.some((k) => t.includes(k));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Cache at the edge for 3 minutes; fresh enough for polling.
  res.setHeader("Cache-Control", "public, s-maxage=180, stale-while-revalidate=600");

  try {
    const [general, oil] = await Promise.all([
      fetchGoogleNews(GENERAL_QUERY).catch((e) => {
        console.error("general feed failed", e);
        return [];
      }),
      fetchGoogleNews(OIL_QUERY).catch((e) => {
        console.error("oil feed failed", e);
        return [];
      }),
    ]);

    // Merge by link, with oilImpact flag
    const byLink = new Map();
    for (const item of general) {
      byLink.set(item.link, { ...item, oilImpact: isOilImpact(item.title + " " + item.description) });
    }
    for (const item of oil) {
      // Oil-query items are explicitly flagged
      const prev = byLink.get(item.link);
      byLink.set(item.link, { ...(prev || item), oilImpact: true });
    }

    const items = Array.from(byLink.values());

    // Sort newest first
    items.sort((a, b) => {
      const ta = Date.parse(a.pubDate) || 0;
      const tb = Date.parse(b.pubDate) || 0;
      return tb - ta;
    });

    res.status(200).json({
      updated: Date.now(),
      count: items.length,
      items: items.slice(0, 60),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
