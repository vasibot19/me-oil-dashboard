// Vercel serverless function: pulls Google News RSS, parses, returns JSON.
// Two query buckets (general ME, oil-focused). Each item gets:
//   - oilImpact: bool (was the item flagged as oil-relevant)
//   - impactScore: 1..5 (how much we'd expect this to move oil prices)

const GENERAL_QUERY =
  '(Iran OR Israel OR "Middle East") AND (conflict OR strike OR attack OR sanctions OR ceasefire OR escalation OR "nuclear talks")';

const OIL_QUERY =
  '(oil OR crude OR Brent OR WTI OR OPEC OR "Strait of Hormuz" OR refinery OR tanker OR pipeline OR embargo) AND (Iran OR Israel OR "Middle East" OR Saudi OR "Persian Gulf" OR Houthi)';

// Oil-impact keyword tiers. Each bullet contributes to the score.
const IMPACT_KEYWORDS = {
  // weight 3: directly disrupts supply or named action on oil infrastructure
  high: [
    "strait of hormuz",
    "hormuz",
    "opec cut",
    "opec+ cut",
    "production cut",
    "production halt",
    "production halted",
    "supply disruption",
    "supply shock",
    "refinery attack",
    "refinery strike",
    "refinery fire",
    "refinery hit",
    "refinery shut",
    "pipeline attack",
    "pipeline blast",
    "pipeline strike",
    "pipeline halt",
    "pipeline closed",
    "saudi aramco",
    "oil export ban",
    "oil embargo",
    "embargo on oil",
    "tanker attack",
    "tanker hit",
    "tanker seized",
    "tanker burning",
    "tanker on fire",
    "oil price spike",
    "oil price jump",
    "oil price surge",
    "oil prices surge",
    "oil prices jump",
    "red sea shipping",
    "shipping lane closed",
    "shipping disruption",
  ],
  // weight 2: military/diplomatic action involving oil-producing region
  medium: [
    "iran attack",
    "iran strike",
    "iranian forces",
    "iran nuclear",
    "israel strike",
    "israel attack",
    "israeli forces",
    "houthi attack",
    "houthi missile",
    "houthi drone",
    "saudi attack",
    "saudi strike",
    "iraq attack",
    "iraqi forces",
    "ceasefire",
    "escalation",
    "missile strike",
    "drone strike",
    "drone attack",
    "embargo",
    "sanctions",
    "oil sanctions",
    "crude oil",
    "brent crude",
    "wti crude",
    "saudi arabia",
    "oil tanker",
    "oil shipping",
    "fuel shock",
    "energy crisis",
    "war fuel",
  ],
  // weight 1: background mentions
  low: [
    "iran",
    "israel",
    "saudi",
    "houthi",
    "iraq",
    "lebanon",
    "syria",
    "yemen",
    "oil",
    "crude",
    "brent",
    "wti",
    "opec",
    "barrel",
    "middle east",
    "persian gulf",
    "gulf",
    "energy market",
    "fuel",
  ],
};

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

function scoreImpact(text) {
  const t = (text || "").toLowerCase();
  let score = 0;
  for (const k of IMPACT_KEYWORDS.high) if (t.includes(k)) score += 3;
  for (const k of IMPACT_KEYWORDS.medium) if (t.includes(k)) score += 2;
  for (const k of IMPACT_KEYWORDS.low) if (t.includes(k)) score += 1;
  // Map raw score → 1..5 bucket. 0 means no oil signal at all.
  if (score === 0) return 0;
  if (score <= 2) return 1;
  if (score <= 4) return 2;
  if (score <= 7) return 3;
  if (score <= 11) return 4;
  return 5;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Cezar wants ~1-min freshness; cache 30s at edge for some buffer.
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");

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

    const byLink = new Map();
    for (const item of general) {
      const text = item.title + " " + item.description;
      const score = scoreImpact(text);
      byLink.set(item.link, { ...item, oilImpact: score >= 1, impactScore: score });
    }
    for (const item of oil) {
      const text = item.title + " " + item.description;
      const score = Math.max(scoreImpact(text), 1); // oil-query items always at least 1
      const prev = byLink.get(item.link);
      byLink.set(item.link, {
        ...(prev || item),
        oilImpact: true,
        impactScore: Math.max(prev?.impactScore || 0, score),
      });
    }

    const items = Array.from(byLink.values());

    items.sort((a, b) => {
      const ta = Date.parse(a.pubDate) || 0;
      const tb = Date.parse(b.pubDate) || 0;
      return tb - ta;
    });

    res.status(200).json({
      updated: Date.now(),
      count: items.length,
      items: items.slice(0, 80),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
