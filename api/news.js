// Vercel serverless function: pulls Google News RSS for ME/oil/Trump,
// scores each item via Gemini (batched, cached per URL), returns JSON.
// Falls back to a keyword heuristic if GEMINI_API_KEY is missing or the call fails.

const GENERAL_QUERY =
  '(Iran OR Israel OR "Middle East") AND (conflict OR strike OR attack OR sanctions OR ceasefire OR escalation OR "nuclear talks")';
const OIL_QUERY =
  '(oil OR crude OR Brent OR WTI OR OPEC OR "Strait of Hormuz" OR refinery OR tanker OR pipeline OR embargo) AND (Iran OR Israel OR "Middle East" OR Saudi OR "Persian Gulf" OR Houthi)';
const TRUMP_QUERY =
  'Trump AND (Iran OR Israel OR "Middle East" OR oil OR Saudi OR Hormuz OR sanctions OR Netanyahu OR OPEC OR "nuclear deal" OR ceasefire OR Houthi)';

// In-memory score cache that survives across warm invocations.
// Each entry: { score, dir, pct, category, oilImpact, isTrump, t (timestamp) }
const scoreCache = new Map();
const SCORE_TTL_MS = 12 * 60 * 60 * 1000; // 12h, then re-score (story may have evolved)

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
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
    const link  = stripTags((block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/) || [])[1] || "");
    const pub   = stripTags((block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    const desc  = stripTags((block.match(/<description\b[^>]*>([\s\S]*?)<\/description>/) || [])[1] || "");
    const src   = stripTags((block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
    if (!title || !link) continue;
    items.push({ title, link, pubDate: pub, description: desc, source: src });
  }
  return items;
}

async function fetchGoogleNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
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

// ----------------- Gemini scoring -----------------

// Try newer model first (more generous free-tier quota), fall back to 2.0 if it's not available.
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];
const GEMINI_BATCH_LIMIT = 50; // Score at most 50 (newest) items per request to stay within free-tier quotas.

function buildPrompt(items) {
  const lines = items.map((it, i) => {
    const ageMin = Math.round((Date.now() - (Date.parse(it.pubDate) || Date.now())) / 60000);
    const src = (it.source || (it.title.match(/\s-\s([^-]+)$/)?.[1] || "")).trim();
    return `[${i}] (${ageMin}m ago) ${src ? src + ": " : ""}${it.title}`;
  }).join("\n");
  return `You are an oil markets analyst covering Brent and WTI crude.

For each news headline below, estimate its expected effect on oil prices over the next 30 minutes. Be conservative — most news scores 1-2. Reserve 4-5 for events that would clearly move the market (refinery hit, OPEC cut, Hormuz disruption, major escalation, ceasefire breakthrough).

Return ONLY a JSON array, one object per input headline, in the same order. Schema for each object:
{
  "i": <input index, integer>,
  "impactScore": <1-5; 1 = negligible, 5 = major move>,
  "direction": "+" | "-" | "0",   // + = bullish (oil up), - = bearish (oil down), 0 = neutral/unclear
  "expectedPct": <number 0-8>,     // expected % move on Brent in next 30min, 0 if direction is 0
  "category": "breaking" | "developing" | "reposted",
  // breaking = urgent / first reporting of a market-moving event
  // developing = significant ongoing story
  // reposted = background, wire repost, summary, or low-impact
  "oilImpact": <boolean>,           // true if directly relates to oil/gas markets, supply, production
  "isTrump": <boolean>              // true if Trump or his admin is the primary actor / subject
}

Headlines:
${lines}`;
}

async function callGemini(model, items, apiKey, diag) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(items) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    diag.push({ src: "gemini", model, status: r.status, items: items.length });
    if (!r.ok) {
      const text = await r.text();
      diag.push({ src: "gemini", model, err: text.slice(0, 180) });
      return { ok: false, status: r.status };
    }
    const data = await r.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch (_) {
      const m = txt.match(/\[[\s\S]*\]/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (__) {}
    }
    if (!Array.isArray(parsed)) {
      diag.push({ src: "gemini", model, err: "non-array response", sample: txt.slice(0, 180) });
      return { ok: false, status: 500 };
    }
    return { ok: true, parsed };
  } catch (e) {
    diag.push({ src: "gemini", model, err: String(e) });
    return { ok: false, status: 0 };
  }
}

async function scoreWithGemini(items, apiKey, diag) {
  if (!items.length) return [];
  // Sort by recency so the top N (most actionable) get Gemini treatment
  const sorted = items
    .map((it, idx) => ({ it, idx, t: Date.parse(it.pubDate) || 0 }))
    .sort((a, b) => b.t - a.t);
  const picked = sorted.slice(0, GEMINI_BATCH_LIMIT);
  const batchItems = picked.map((p) => p.it);

  for (const model of GEMINI_MODELS) {
    const res = await callGemini(model, batchItems, apiKey, diag);
    if (res.ok) {
      // Remap the batch indexes back to original indexes
      return res.parsed.map((s) => {
        if (s == null || typeof s.i !== "number") return s;
        const orig = picked[s.i];
        return orig ? { ...s, i: orig.idx } : s;
      });
    }
    // If 429 or 403, try next model; any other error also tries next
  }
  return null;
}

// ----------------- Keyword fallback -----------------

const HIGH = ["strait of hormuz","hormuz","opec cut","production cut","supply disruption","refinery attack","refinery fire","pipeline attack","saudi aramco","oil embargo","tanker attack","tanker seized","red sea shipping","trump strikes iran"];
const MED  = ["iran attack","iran strike","israel strike","israel attack","houthi attack","houthi missile","ceasefire","escalation","missile strike","drone attack","sanctions","crude oil","brent crude","wti crude","trump iran","trump israel","trump oil","white house iran"];
const LOW  = ["iran","israel","saudi","houthi","iraq","oil","crude","brent","wti","opec","barrel","middle east","trump"];
const BULL = ["hormuz closed","refinery attack","pipeline blast","tanker attack","saudi aramco attack","supply disruption","iran strike","israel strike iran","houthi attack","new sanctions","oil embargo","opec cut","trump strikes iran","escalates"];
const BEAR = ["ceasefire reached","truce reached","peace deal","nuclear deal reached","sanctions lifted","embargo lifted","opec increase","de-escalation","oversupply","oil glut","iran agrees","talks resume","trump pushes ceasefire"];
const FLIP = [/no ceasefire/i, /ceasefire (?:collapses|broken|breaks|fails|expires|rejected)/i, /(?:rejects|refuses|walks out of) (?:talks|deal|ceasefire)/i, /deal (?:fails|collapses|rejected)/i, /sanctions (?:imposed|tightened|reinstated)/i];
const BREAKING_MARKERS = ["breaking","developing","urgent","just in","live updates","live:","alert:","happening now"];

function fallbackScore(item) {
  const text = (item.title + " " + item.description).toLowerCase();
  let raw = 0;
  for (const k of HIGH) if (text.includes(k)) raw += 3;
  for (const k of MED)  if (text.includes(k)) raw += 2;
  for (const k of LOW)  if (text.includes(k)) raw += 1;
  const score = raw === 0 ? 0 : raw <= 2 ? 1 : raw <= 4 ? 2 : raw <= 7 ? 3 : raw <= 11 ? 4 : 5;
  let bull = 0, bear = 0;
  for (const k of BULL) if (text.includes(k)) bull++;
  for (const k of BEAR) if (text.includes(k)) bear++;
  for (const re of FLIP) if (re.test(text)) { bull += 2; bear = Math.max(0, bear - 2); }
  let dir = bull > bear ? 1 : bear > bull ? -1 : 0;
  if (dir === 0 && score >= 3) dir = 1;
  const mag = score === 0 ? 0 : score === 1 ? 0.2 : score === 2 ? 0.5 : score === 3 ? 1.2 : score === 4 ? 2.5 : 5.0;
  const pct = dir === 0 ? 0 : Math.round(mag * 10) / 10;
  const ageMin = (Date.now() - (Date.parse(item.pubDate) || Date.now())) / 60000;
  const titleHasBreaking = BREAKING_MARKERS.some((m) => text.includes(m));
  let category = "reposted";
  if (titleHasBreaking || (ageMin <= 30 && score >= 3)) category = "breaking";
  else if (ageMin <= 360 && score >= 2) category = "developing";
  const isTrump = /\btrump\b|white house|us strikes/.test(text);
  return {
    impactScore: score,
    expectedDirection: dir,
    expectedPct: pct,
    category,
    isBreaking: category === "breaking",
    oilImpact: score >= 1,
    isTrump,
    scoredBy: "fallback",
  };
}

function applyScore(item, scoreObj, scoredBy) {
  const score   = Math.max(0, Math.min(5, scoreObj.impactScore | 0));
  const dirRaw  = scoreObj.direction;
  const dir     = dirRaw === "+" ? 1 : dirRaw === "-" ? -1 : 0;
  const pct     = Math.max(0, Math.min(8, Number(scoreObj.expectedPct) || 0));
  const cat     = ["breaking","developing","reposted"].includes(scoreObj.category) ? scoreObj.category : "reposted";
  return {
    impactScore: score,
    expectedDirection: dir,
    expectedPct: dir === 0 ? 0 : Math.round(pct * 10) / 10,
    category: cat,
    isBreaking: cat === "breaking",
    oilImpact: !!scoreObj.oilImpact || score >= 2,
    isTrump: !!scoreObj.isTrump,
    scoredBy: scoredBy || "gemini",
  };
}

// ----------------- Main handler -----------------

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=180");
  const debug = "debug" in req.query;
  const diag = [];
  // Cache buster for testing: ?bustcache=1 drops the in-memory score cache so the next batch hits Gemini fresh
  if (req.query.bustcache) {
    diag.push({ src: "cache", note: "cleared", prevSize: scoreCache.size });
    scoreCache.clear();
  }

  try {
    const [general, oil, trump] = await Promise.all([
      fetchGoogleNews(GENERAL_QUERY).catch((e) => { diag.push({src:"general",err:String(e)}); return []; }),
      fetchGoogleNews(OIL_QUERY)    .catch((e) => { diag.push({src:"oil",err:String(e)});     return []; }),
      fetchGoogleNews(TRUMP_QUERY)  .catch((e) => { diag.push({src:"trump",err:String(e)});   return []; }),
    ]);

    // Dedupe by link, capture the bucket(s) each item came from
    const byLink = new Map();
    function add(item, bucket) {
      const prev = byLink.get(item.link);
      const merged = { ...(prev || item), buckets: [ ...(prev?.buckets || []), bucket ] };
      byLink.set(item.link, merged);
    }
    for (const it of general) add(it, "general");
    for (const it of oil)     add(it, "oil");
    for (const it of trump)   add(it, "trump");
    const items = Array.from(byLink.values());

    // Split items into "need scoring" (uncached or expired) vs "cached"
    const now = Date.now();
    const need = [];
    for (const it of items) {
      const cached = scoreCache.get(it.link);
      if (cached && (now - cached.t) < SCORE_TTL_MS) {
        Object.assign(it, cached.score);
      } else {
        need.push(it);
      }
    }

    const apiKey = process.env.GEMINI_API_KEY;
    let geminiUsed = false;
    if (need.length && apiKey) {
      const scored = await scoreWithGemini(need, apiKey, diag);
      if (Array.isArray(scored)) {
        geminiUsed = true;
        for (const s of scored) {
          const idx = s.i;
          if (idx == null || idx < 0 || idx >= need.length) continue;
          const item = need[idx];
          const enriched = applyScore(item, s, "gemini");
          // Trump-bucket items get isTrump=true even if Gemini missed it
          if (item.buckets?.includes("trump")) enriched.isTrump = true;
          // Oil-bucket items get oilImpact=true
          if (item.buckets?.includes("oil")) enriched.oilImpact = true;
          Object.assign(item, enriched);
          scoreCache.set(item.link, { score: enriched, t: now });
        }
      }
    }

    // Fallback for anything still unscored (no API key, Gemini failed, or item missing in response)
    for (const it of need) {
      if (it.impactScore == null) {
        const s = fallbackScore(it);
        if (it.buckets?.includes("trump")) s.isTrump = true;
        if (it.buckets?.includes("oil"))   s.oilImpact = true;
        Object.assign(it, s);
        scoreCache.set(it.link, { score: s, t: now });
      }
    }

    // Cap cache growth
    if (scoreCache.size > 500) {
      const sorted = [...scoreCache.entries()].sort((a, b) => b[1].t - a[1].t);
      scoreCache.clear();
      for (const [k, v] of sorted.slice(0, 250)) scoreCache.set(k, v);
    }

    items.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));

    res.status(200).json({
      updated: now,
      count: items.length,
      breakingCount: items.filter((i) => i.isBreaking).length,
      scorer: geminiUsed ? "gemini" : (apiKey ? "fallback (gemini failed)" : "fallback (no api key)"),
      items: items.slice(0, 100),
      ...(debug ? { diag, cacheSize: scoreCache.size, needCount: need.length } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
