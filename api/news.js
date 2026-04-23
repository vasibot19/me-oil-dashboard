// Vercel serverless function: pulls Google News RSS, parses, returns JSON.
// Three query buckets: general ME, oil-focused, Trump-on-ME.
// Each item gets:
//   - oilImpact: bool
//   - impactScore: 1..5 (oil-price influence)
//   - category: "breaking" | "developing" | "reposted"
//   - isBreaking: bool (item should appear in the live band)

const GENERAL_QUERY =
  '(Iran OR Israel OR "Middle East") AND (conflict OR strike OR attack OR sanctions OR ceasefire OR escalation OR "nuclear talks")';

const OIL_QUERY =
  '(oil OR crude OR Brent OR WTI OR OPEC OR "Strait of Hormuz" OR refinery OR tanker OR pipeline OR embargo) AND (Iran OR Israel OR "Middle East" OR Saudi OR "Persian Gulf" OR Houthi)';

// Trump query: anything Trump says/does that touches Middle East / oil
const TRUMP_QUERY =
  'Trump AND (Iran OR Israel OR "Middle East" OR oil OR Saudi OR Hormuz OR sanctions OR Netanyahu OR OPEC OR "nuclear deal" OR ceasefire OR Houthi)';

const IMPACT_KEYWORDS = {
  high: [
    "strait of hormuz", "hormuz",
    "opec cut", "opec+ cut", "production cut", "production halt", "production halted",
    "supply disruption", "supply shock",
    "refinery attack", "refinery strike", "refinery fire", "refinery hit", "refinery shut",
    "pipeline attack", "pipeline blast", "pipeline strike", "pipeline halt", "pipeline closed",
    "saudi aramco",
    "oil export ban", "oil embargo", "embargo on oil",
    "tanker attack", "tanker hit", "tanker seized", "tanker burning", "tanker on fire",
    "oil price spike", "oil price jump", "oil price surge", "oil prices surge", "oil prices jump",
    "red sea shipping", "shipping lane closed", "shipping disruption",
    "trump sanctions iran", "trump strikes iran", "trump tariffs oil",
  ],
  medium: [
    "iran attack", "iran strike", "iranian forces", "iran nuclear",
    "israel strike", "israel attack", "israeli forces",
    "houthi attack", "houthi missile", "houthi drone",
    "saudi attack", "saudi strike",
    "iraq attack", "iraqi forces",
    "ceasefire", "escalation", "missile strike", "drone strike", "drone attack",
    "embargo", "sanctions", "oil sanctions",
    "crude oil", "brent crude", "wti crude",
    "saudi arabia", "oil tanker", "oil shipping",
    "fuel shock", "energy crisis", "war fuel",
    "trump iran", "trump israel", "trump oil", "trump saudi", "trump opec",
    "white house iran", "white house israel", "us strikes",
  ],
  low: [
    "iran", "israel", "saudi", "houthi", "iraq", "lebanon", "syria", "yemen",
    "oil", "crude", "brent", "wti", "opec", "barrel",
    "middle east", "persian gulf", "gulf",
    "energy market", "fuel",
    "trump", "white house", "pentagon",
  ],
};

// Words / phrases that flag a news item as breaking news (urgency)
const BREAKING_MARKERS = [
  "breaking", "developing", "urgent", "just in", "live updates",
  "live:", "alert:", "(updated)", "happening now",
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
function stripTags(s) { return decodeEntities(s).replace(/<[^>]+>/g, "").trim(); }

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
  return parseRss(await r.text());
}

function scoreImpact(text) {
  const t = (text || "").toLowerCase();
  let score = 0;
  for (const k of IMPACT_KEYWORDS.high) if (t.includes(k)) score += 3;
  for (const k of IMPACT_KEYWORDS.medium) if (t.includes(k)) score += 2;
  for (const k of IMPACT_KEYWORDS.low) if (t.includes(k)) score += 1;
  if (score === 0) return 0;
  if (score <= 2) return 1;
  if (score <= 4) return 2;
  if (score <= 7) return 3;
  if (score <= 11) return 4;
  return 5;
}

function classify(item, score) {
  const t = (item.title + " " + item.description).toLowerCase();
  const titleHasBreaking = BREAKING_MARKERS.some((m) => t.includes(m));
  const ageMs = Date.now() - (Date.parse(item.pubDate) || Date.now());
  const ageMin = ageMs / 60000;
  // Breaking: explicit marker, OR <30 min old + impact ≥ 3
  if (titleHasBreaking) return "breaking";
  if (ageMin <= 30 && score >= 3) return "breaking";
  // Developing: <6h old + impact ≥ 2
  if (ageMin <= 360 && score >= 2) return "developing";
  return "reposted";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");

  try {
    const [general, oil, trump] = await Promise.all([
      fetchGoogleNews(GENERAL_QUERY).catch((e) => { console.error("general", e); return []; }),
      fetchGoogleNews(OIL_QUERY).catch((e) => { console.error("oil", e); return []; }),
      fetchGoogleNews(TRUMP_QUERY).catch((e) => { console.error("trump", e); return []; }),
    ]);

    const byLink = new Map();

    function add(item, opts = {}) {
      const text = item.title + " " + item.description;
      const baseScore = scoreImpact(text);
      // Trump bucket boosts score by +1 (Trump statements move oil)
      const score = Math.min(5, Math.max(opts.minScore || 0, baseScore + (opts.trump ? 1 : 0)));
      const prev = byLink.get(item.link);
      const merged = {
        ...(prev || item),
        oilImpact: prev?.oilImpact || score >= 1 || opts.oil,
        impactScore: Math.max(prev?.impactScore || 0, score),
        isTrump: prev?.isTrump || !!opts.trump,
      };
      merged.category = classify(merged, merged.impactScore);
      merged.isBreaking = merged.category === "breaking";
      byLink.set(item.link, merged);
    }

    for (const item of general) add(item);
    for (const item of oil)     add(item, { oil: true, minScore: 1 });
    for (const item of trump)   add(item, { trump: true, minScore: 1 });

    const items = Array.from(byLink.values());

    // Sort newest first
    items.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));

    res.status(200).json({
      updated: Date.now(),
      count: items.length,
      breakingCount: items.filter((i) => i.isBreaking).length,
      items: items.slice(0, 100),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
