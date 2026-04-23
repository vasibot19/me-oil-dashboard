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

// Bullish (price up) signals: supply shock, escalation, sanctions ON, OPEC cuts.
const BULLISH_KEYWORDS = [
  // supply / infrastructure hits
  "hormuz closed", "hormuz blocked", "hormuz shut",
  "refinery attack", "refinery strike", "refinery fire", "refinery hit", "refinery shut",
  "pipeline attack", "pipeline blast", "pipeline halt", "pipeline closed", "pipeline strike",
  "tanker attack", "tanker hit", "tanker seized", "tanker burning", "tanker on fire",
  "saudi aramco attack", "aramco attack",
  "supply disruption", "supply shock", "production halt", "production halted",
  "shipping disruption", "shipping lane closed", "red sea attack",
  "oil price spike", "oil price jump", "oil price surge", "oil prices surge", "oil prices jump",
  // escalation / strikes
  "iran strike", "iran attack", "strikes iran", "strike on iran",
  "israel strike iran", "israel attacks iran", "israeli strikes",
  "houthi attack", "houthi missile", "houthi drone", "houthi strike",
  "us strikes iran", "trump strikes iran", "trump bombs",
  "war escalation", "escalation in", "escalates",
  "drone strike on", "missile strike on",
  // sanctions ADDED (cuts supply)
  "new sanctions", "sanctions on iran oil", "sanctions on russian oil",
  "oil embargo", "embargo on oil", "sanctions imposed", "tightens sanctions",
  // OPEC cuts
  "opec cut", "opec+ cut", "production cut", "supply cut", "output cut",
  // hoarding / panic
  "stockpiled", "hoarding oil", "rush to buy",
];

// Bearish (price down) signals: de-escalation, deal/peace, OPEC increase, sanctions lifted.
const BEARISH_KEYWORDS = [
  "ceasefire reached", "ceasefire holds", "truce reached", "peace deal",
  "nuclear deal reached", "deal reached", "agreement signed",
  "sanctions lifted", "sanctions eased", "embargo lifted", "lift sanctions",
  "opec increase", "opec+ increase", "production increase", "supply increase", "boost production",
  "de-escalation", "tensions ease", "tensions easing",
  "oil demand falls", "recession fears", "demand destruction",
  "oversupply", "oil glut", "glut",
  "iran agrees", "israel withdraws", "talks resume", "diplomatic breakthrough",
  "trump pushes ceasefire", "trump brokers", "trump deal",
];

// Patterns that flip a bearish-looking phrase back to bullish (or vice versa)
const FLIP_PATTERNS = [
  /no ceasefire/i,
  /ceasefire (?:collapses|broken|breaks|fails|expires|rejected)/i,
  /(?:rejects|refuses|walks out of) (?:talks|deal|ceasefire)/i,
  /deal (?:fails|collapses|rejected)/i,
  /sanctions (?:imposed|tightened|reinstated)/i,
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
  if (titleHasBreaking) return "breaking";
  if (ageMin <= 30 && score >= 3) return "breaking";
  if (ageMin <= 360 && score >= 2) return "developing";
  return "reposted";
}

// Direction & magnitude estimate. Returns { direction: -1|0|+1, expectedPct: number }.
// expectedPct is a rough median percentage we'd expect oil to move on this kind of news,
// scaled by impact score. Direction comes from bullish/bearish keyword count + flip patterns.
function estimateImpact(item, score) {
  const text = (item.title + " " + item.description).toLowerCase();
  let bullish = 0, bearish = 0;
  for (const k of BULLISH_KEYWORDS) if (text.includes(k)) bullish++;
  for (const k of BEARISH_KEYWORDS) if (text.includes(k)) bearish++;
  // Flip patterns turn an apparently-bearish item bullish (e.g. "ceasefire collapses")
  for (const re of FLIP_PATTERNS) {
    if (re.test(text)) { bullish += 2; bearish = Math.max(0, bearish - 2); }
  }
  let direction = 0;
  if (bullish > bearish) direction = 1;
  else if (bearish > bullish) direction = -1;
  // Median % move expectation, scaled by magnitude bucket.
  const magBase = score === 0 ? 0
    : score === 1 ? 0.2
    : score === 2 ? 0.5
    : score === 3 ? 1.2
    : score === 4 ? 2.5
    : 5.0;
  // If we have no direction signal but score >= 3, mark direction as +1 (geopolitical
  // escalation in ME defaults bullish for oil) — common case for unflagged escalation news.
  if (direction === 0 && score >= 3) direction = 1;
  const expectedPct = magBase * (direction === 0 ? 0 : 1);
  return { direction, expectedPct: Math.round(expectedPct * 10) / 10 };
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
      const impact = estimateImpact(merged, merged.impactScore);
      merged.expectedDirection = impact.direction; // -1 | 0 | +1
      merged.expectedPct = impact.expectedPct;     // e.g. 1.2 (means ~+1.2%)
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
