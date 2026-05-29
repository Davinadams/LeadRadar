require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1hr cache per query
const PORT = process.env.PORT || 3000;
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!GOOGLE_KEY && GOOGLE_KEY !== 'your_google_places_api_key_here',
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY
  });
});

// ─── Main lead search endpoint ────────────────────────────────────────────────
// GET /api/leads?industry=plumbers&location=Austin%2C+TX&filter=no_website
app.get('/api/leads', async (req, res) => {
  if (!GOOGLE_KEY || GOOGLE_KEY === 'your_google_places_api_key_here') {
    return res.status(503).json({ error: 'NO_KEY', message: 'Google Places API key not configured. See .env.example.' });
  }

  const { industry, location } = req.query;  // filters now applied client-side
  if (!industry || !location) {
    return res.status(400).json({ error: 'Missing industry or location' });
  }

  const cacheKey = `${industry}|${location}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const query = `${industry} in ${location}`;

    // Fetch up to 3 pages (60 results max) from Google Places
    let allRawPlaces = [];
    let nextPageToken = null;
    let globalRank = 0;

    for (let page = 0; page < 3; page++) {
      const params = { query, key: GOOGLE_KEY, type: 'establishment' };
      if (nextPageToken) params.pagetoken = nextPageToken;

      // Google requires a short delay before using a next_page_token
      if (page > 0) await new Promise(r => setTimeout(r, 2000));

      const placesRes = await axios.get(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
        { params }
      );

      if (placesRes.data.status === 'REQUEST_DENIED') {
        return res.status(403).json({ error: 'API_DENIED', message: placesRes.data.error_message });
      }
      if (placesRes.data.status === 'OVER_QUERY_LIMIT') {
        if (allRawPlaces.length === 0) return res.status(429).json({ error: 'QUOTA', message: 'Google API quota exceeded.' });
        break; // use what we have
      }

      const pageResults = placesRes.data.results || [];
      allRawPlaces = allRawPlaces.concat(pageResults);
      nextPageToken = placesRes.data.next_page_token || null;
      if (!nextPageToken) break; // no more pages
    }

    // Enrich each place with details (website, phone, hours)
    // Pass global rank so businesses keep their true search position
    const enriched = await Promise.all(
      allRawPlaces.map((p, idx) => enrichPlace(p.place_id, p, idx + 1))
    );
    const rawPlaces = allRawPlaces;

    // Score all leads — filtering is done client-side so combinations work
    const leads = enriched
      .map(l => ({ ...l, score: scoreLead(l) }))
      .sort((a, b) => b.score - a.score);

    const result = {
      leads,
      total: leads.length,
      rawTotal: rawPlaces.length,
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Places API error:', err.message);
    res.status(500).json({ error: 'FETCH_FAILED', message: err.message });
  }
});

// ─── Place detail enrichment ──────────────────────────────────────────────────
async function enrichPlace(placeId, base, searchRank) {
  try {
    const fields = [
      'name', 'formatted_address', 'formatted_phone_number',
      'website', 'rating', 'user_ratings_total',
      'opening_hours', 'types', 'url', 'business_status',
      'photos'
    ].join(',');

    const detailRes = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      { params: { place_id: placeId, fields, key: GOOGLE_KEY } }
    );

    const d = detailRes.data.result || {};
    return {
      place_id: placeId,
      name: d.name || base.name,
      address: d.formatted_address || base.formatted_address,
      phone: d.formatted_phone_number || null,
      website: d.website || null,
      rating: d.rating || base.rating || null,
      review_count: d.user_ratings_total || base.user_ratings_total || 0,
      types: d.types || base.types || [],
      google_maps_url: d.url || `https://maps.google.com/?cid=${placeId}`,
      is_open: d.opening_hours?.open_now ?? null,
      has_hours: !!(d.opening_hours),
      business_status: d.business_status || 'OPERATIONAL',
      // Derived flags
      no_website: !d.website,
      is_hidden_gem: (d.rating >= 4.5) && (d.user_ratings_total < 50) && (d.user_ratings_total > 3),
      photo_ref: d.photos?.[0]?.photo_reference || null,
      // Google Maps search ranking
      search_rank: searchRank || null,
      in_3pack: searchRank <= 3,
      rank_label: searchRank <= 3 ? 'Top 3 on Google Maps' : searchRank <= 10 ? 'Page 1 on Google Maps' : 'Low Google visibility',
    };
  } catch {
    return {
      place_id: placeId,
      name: base.name,
      address: base.formatted_address,
      phone: null,
      website: null,
      rating: base.rating,
      review_count: base.user_ratings_total || 0,
      types: base.types || [],
      google_maps_url: `https://maps.google.com/?q=${encodeURIComponent(base.name)}`,
      is_open: null,
      no_website: true,
      is_hidden_gem: (base.rating >= 4.5) && ((base.user_ratings_total || 0) < 50) && ((base.user_ratings_total || 0) > 3),
      search_rank: searchRank || null,
      in_3pack: searchRank <= 3,
      rank_label: searchRank <= 3 ? 'Top 3 on Google Maps' : searchRank <= 10 ? 'Page 1 on Google Maps' : 'Low Google visibility',
    };
  }
}

// ─── Initial opportunity score ────────────────────────────────────────────────
function scoreLead(lead) { return calcOpportunityScore(lead); }

// ─── Opportunity Scoring ─────────────────────────────────────────────────────
// Higher score = better lead.
//
// WEBSITE QUALITY   0-50 pts  (biggest factor — weak/template site ≈ no website)
// GOOGLE MAPS RANK  0-35 pts  (tiebreaker — rank 1=2pts, rank 60=35pts)
// SOCIAL SIGNALS    0-15 pts  (review count + recency as proxy)
//
// Website tiers:
//   No website                          → 50
//   Wix / Squarespace / template site   → 38-42
//   Has site but no SSL + not mobile    → 30-35
//   Basic/outdated site                 → 20-28
//   Average site                        → 10-18
//   Good modern site                    → 2-8

function calcOpportunityScore(lead) {
  let score = 0;

  // ── 1. Website quality (0-50) ──────────────────────────────────────────────
  if (!lead.website) {
    score += 50;
  } else {
    let webScore = 0;

    // Base tier from platform detection
    if (lead.site_platform === 'wix')          webScore = 38;
    else if (lead.site_platform === 'squarespace') webScore = 35;
    else if (lead.site_platform === 'weebly')   webScore = 38;
    else if (lead.site_platform === 'godaddy')  webScore = 36;
    else if (lead.site_platform === 'jimdo')    webScore = 37;
    else                                        webScore = 18; // unknown = assume average

    // Adjust from PageSpeed data
    if (lead.psi) {
      if (!lead.psi.mobile_friendly)             webScore += 7;
      if (lead.psi.performance < 40)             webScore += 7;
      else if (lead.psi.performance < 65)        webScore += 3;
      if (lead.psi.seo < 50)                     webScore += 7;
      else if (lead.psi.seo < 75)                webScore += 3;
      if (lead.psi.best_practices < 50)          webScore += 4;
      // Good signals reduce score
      if (lead.psi.performance >= 80 && lead.psi.seo >= 80 && lead.psi.mobile_friendly) {
        webScore = Math.max(webScore - 12, 2);
      }
    }
    // SSL missing
    if (lead.ssl === false) webScore += 6;
    // Gmail / free email detected
    if (lead.has_free_email) webScore += 5;

    score += Math.min(webScore, 50);
  }

  // ── 2. Google Maps rank (0-35) — tiebreaker ───────────────────────────────
  const rank = Math.min(Math.max(lead.search_rank || 60, 1), 60);
  const rankScore = Math.round(((rank - 1) / 59) * 33) + 2;
  score += rankScore;

  // ── 3. Social media proxy + hidden gem bonus (0-15) ──────────────────────
  const reviews = lead.review_count || 0;
  if (reviews < 5)         score += 15;
  else if (reviews < 15)   score += 10;
  else if (reviews < 30)   score += 6;
  else if (reviews < 75)   score += 3;
  else if (reviews < 150)  score += 1;
  // Hidden gem bonus — highly rated but undiscovered = easy close
  if (lead.is_hidden_gem)  score += 5;

  return Math.min(Math.max(Math.round(score), 0), 100);
}

function rankToBaseScore(rank) {
  const r = Math.min(Math.max(rank || 60, 1), 60);
  return Math.round(((r - 1) / 59) * 33) + 2;
}

// Fast SSL check
async function checkSSL(url) {
  try {
    const httpsUrl = url.replace(/^http:\/\//i, "https://");
    const r = await axios.head(httpsUrl, { timeout: 5000, maxRedirects: 3 });
    return r.status < 400;
  } catch { return url.startsWith("https://"); }
}

// Quick platform detection — fetch page and check meta generator + free email
async function detectSitePlatform(url) {
  const cacheKey = "platform|" + url;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const testUrl = url.replace(/^http:\/\//i, "https://");
    const r = await axios.get(testUrl, { timeout: 8000, maxRedirects: 3, headers: { "User-Agent": "Mozilla/5.0" } });
    const html = r.data || "";
    let platform = "unknown";
    if (/wix\.com|wixstatic\.com|meta.*generator.*wix/i.test(html))         platform = "wix";
    else if (/squarespace\.com|meta.*generator.*squarespace/i.test(html))   platform = "squarespace";
    else if (/weebly\.com|meta.*generator.*weebly/i.test(html))             platform = "weebly";
    else if (/godaddy\.com|meta.*generator.*godaddy/i.test(html))           platform = "godaddy";
    else if (/jimdo\.com|meta.*generator.*jimdo/i.test(html))               platform = "jimdo";

    // Detect free/personal email on page
    const hasFreeEmail = /@gmail\.com|@yahoo\.com|@hotmail\.com|@outlook\.com/i.test(html);

    const result = { platform, has_free_email: hasFreeEmail };
    cache.set(cacheKey, result, 86400);
    return result;
  } catch { return { platform: "unknown", has_free_email: false }; }
}

// Full PageSpeed audit
async function runPageSpeedAudit(url) {
  const cacheKey = "psi|" + url;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const testUrl = url.replace(/^http:\/\//i, "https://");
  try {
    const r = await axios.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", {
      params: { url: testUrl, strategy: "mobile", category: ["performance", "seo", "best-practices"] },
      timeout: 30000
    });
    const cats = r.data.lighthouseResult?.categories || {};
    const audits = r.data.lighthouseResult?.audits || {};
    const result = {
      performance:    Math.round((cats.performance?.score    || 0) * 100),
      seo:            Math.round((cats.seo?.score            || 0) * 100),
      best_practices: Math.round((cats["best-practices"]?.score || 0) * 100),
      mobile_friendly: audits["viewport"]?.score !== 0,
      issues: []
    };
    if (!result.mobile_friendly)      result.issues.push("Not mobile-friendly");
    if (result.performance < 40)      result.issues.push("Very slow (" + result.performance + "/100)");
    else if (result.performance < 65) result.issues.push("Slow (" + result.performance + "/100)");
    if (result.seo < 50)              result.issues.push("Weak SEO (" + result.seo + "/100)");
    if (audits["meta-description"]?.score === 0) result.issues.push("No meta description");
    if (audits["is-crawlable"]?.score === 0)     result.issues.push("Blocked from Google");
    cache.set(cacheKey, result, 86400);
    return result;
  } catch(e) { return null; }
}

// ─── Per-site website audit endpoint ─────────────────────────────────────────
app.get('/api/site-audit', async (req, res) => {
  const { url, place_id } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const [psi, ssl, platformData] = await Promise.all([
      runPageSpeedAudit(url),
      checkSSL(url),
      detectSitePlatform(url)
    ]);
    res.json({ place_id, psi, ssl, site_platform: platformData.platform, has_free_email: platformData.has_free_email });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pitch reason generator (no API key required) ────────────────────────────
function generatePitchReason(l) {
  const rank = l.search_rank || 20;
  const reviews = l.review_count || 0;
  const rankStr = `ranks #${rank} on Google Maps`;
  if (!l.website && rank >= 30)  return `No website and ${rankStr} — virtually invisible to new customers`;
  if (!l.website && rank >= 15)  return `No website and ${rankStr} — competitors are getting their customers`;
  if (!l.website)                return `No website — ${rankStr} and missing out on online leads`;
  if (l.site_platform === 'wix') return `Wix template site and ${rankStr} — a professional site could double their calls`;
  if (l.site_platform === 'squarespace') return `Squarespace template and ${rankStr} — easy upgrade opportunity`;
  if (l.has_free_email)          return `Using Gmail for business and ${rankStr} — not taken seriously online`;
  if (rank >= 40)                return `${rankStr} — almost impossible for new customers to find them`;
  if (rank >= 20)                return `${rankStr} — most customers never scroll this far`;
  if (reviews < 10)              return `Only ${reviews} reviews and ${rankStr} — very low online presence`;
  return `${rankStr} with room to grow their digital presence`;
}

app.post('/api/score-leads', async (req, res) => {
  const { leads, industry, location } = req.body;
  if (!leads || !industry || !location) return res.status(400).json({ error: 'Missing data' });

  const cacheKey = `pitches|${industry}|${location}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ scores: cached });

  // Try Anthropic if key is available, otherwise use local generation
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (ANTHROPIC_KEY) {
    const summaries = leads.map((l, i) => ({
      i, name: l.name, rank: l.search_rank, has_website: !!l.website,
      reviews: l.review_count, site_platform: l.site_platform || null
    }));
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-20250514', max_tokens: 1500,
        messages: [{ role: 'user', content: `For each business write a one-sentence pitch reason about their biggest digital weakness. Punchy and specific.
Industry: ${industry} | Location: ${location}
Businesses: ${JSON.stringify(summaries)}
Respond ONLY with JSON: [{"i":0,"pitch_reason":"..."},...]` }]
      }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      const text = r.data.content.map(c => c.text||'').join('').replace(/```json|```/g,'').trim();
      const pitches = JSON.parse(text);
      cache.set(cacheKey, pitches, 3600);
      return res.json({ scores: pitches });
    } catch(e) { /* fall through to local */ }
  }

  // Local pitch generation — no API key needed
  const pitches = leads.map((l, i) => ({ i, pitch_reason: generatePitchReason(l) }));
  cache.set(cacheKey, pitches, 3600);
  res.json({ scores: pitches });
});

// ─── Photo proxy (avoids exposing key in frontend) ────────────────────────────
app.get('/api/photo', async (req, res) => {
  const { ref, maxwidth = 400 } = req.query;
  if (!ref) return res.status(400).send('Missing ref');
  try {
    const photoRes = await axios.get(
      'https://maps.googleapis.com/maps/api/place/photo',
      { params: { photoreference: ref, maxwidth, key: GOOGLE_KEY }, responseType: 'stream' }
    );
    photoRes.data.pipe(res);
  } catch {
    res.status(404).send('Photo not found');
  }
});

// ─── Pipeline persistence (server-side JSON store, file-based) ────────────────
const fs = require('fs');
const PIPELINE_FILE = path.join(__dirname, 'pipeline.json');

function loadPipeline() {
  try { return JSON.parse(fs.readFileSync(PIPELINE_FILE, 'utf8')); }
  catch { return []; }
}
function savePipelineFile(data) {
  fs.writeFileSync(PIPELINE_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/pipeline', (req, res) => res.json(loadPipeline()));

app.post('/api/pipeline', (req, res) => {
  const pipeline = loadPipeline();
  const lead = req.body;
  if (!lead || !lead.place_id) return res.status(400).json({ error: 'Invalid lead' });
  if (!pipeline.find(l => l.place_id === lead.place_id)) {
    pipeline.push({ ...lead, status: 'new', added: new Date().toISOString() });
    savePipelineFile(pipeline);
  }
  res.json({ ok: true, total: pipeline.length });
});

app.patch('/api/pipeline/:id', (req, res) => {
  const pipeline = loadPipeline();
  const idx = pipeline.findIndex(l => l.place_id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  pipeline[idx] = { ...pipeline[idx], ...req.body };
  savePipelineFile(pipeline);
  res.json({ ok: true });
});

app.delete('/api/pipeline/:id', (req, res) => {
  let pipeline = loadPipeline();
  pipeline = pipeline.filter(l => l.place_id !== req.params.id);
  savePipelineFile(pipeline);
  res.json({ ok: true, total: pipeline.length });
});

// ─── Notes per lead ───────────────────────────────────────────────────────────
app.post('/api/pipeline/:id/notes', (req, res) => {
  const pipeline = loadPipeline();
  const idx = pipeline.findIndex(l => l.place_id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const note = { text: req.body.text, ts: new Date().toISOString() };
  pipeline[idx].notes = [...(pipeline[idx].notes || []), note];
  savePipelineFile(pipeline);
  res.json({ ok: true });
});

// ─── Outreach generation (Anthropic if available, template fallback) ─────────
function generateOutreachTemplate(lead, type) {
  const name = lead.name;
  const city = (lead.address || '').split(',').slice(1,2).join('').trim() || 'your area';
  const noSite = lead.no_website;
  const platform = lead.site_platform && lead.site_platform !== 'unknown' ? lead.site_platform : null;
  const weakness = noSite ? "don't have a website" : platform ? `have a ${platform} template site` : "have an outdated website";

  if (type === 'email') return `Subject: Quick question about ${name}'s online presence

Hi,

I was searching for ${lead.types?.[0] || 'businesses'} in ${city} and came across ${name}. I noticed you ${weakness} — I build professional websites for local businesses and I think I could help you get more calls and customers.

Would you be open to a quick 10-minute call this week?

Best,
[Your name]
[Your phone]`;
  if (type === 'sms')  return `Hi, I found ${name} on Google Maps. I help local businesses get more customers with professional websites. You ${weakness} — interested in a free quote?`;
  if (type === 'call') return `Hi, is this ${name}?

Great — my name is [Your name] and I'm a local web designer. I was searching Google for ${lead.types?.[0] || 'businesses'} in ${city} and I came across your business.

I noticed you ${weakness}, and I specialize in helping businesses like yours get more customers online.

I'd love to show you some examples of what I've done for similar businesses — would you have 10 minutes this week for a quick call?

[Handle objections, offer free mockup]`;
  if (type === 'dm')   return `Hey! I found ${name} while looking for ${lead.types?.[0] || 'local businesses'} in ${city}. I noticed you ${weakness} — I build websites for local businesses and would love to help. Mind if I send you some examples?`;
  return '';
}

app.post('/api/outreach', async (req, res) => {
  const { lead, type } = req.body;
  if (!lead || !type) return res.status(400).json({ error: 'Missing lead or type' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (ANTHROPIC_KEY) {
    const typeLabels = { email: 'cold email', sms: 'SMS text message (under 160 chars)', call: '60-second phone call script', dm: 'Instagram/Facebook DM (under 100 words)' };
    const prompt = `Write a personalized ${typeLabels[type]} for outreach to ${lead.name}, a local business owner.
Address: ${lead.address}
Rating: ★${lead.rating} (${lead.review_count} reviews)
Website status: ${lead.no_website ? 'No website' : lead.site_platform ? lead.site_platform + ' template site' : 'Has website'}
${type === 'email' ? 'Include subject line as "Subject: ..."' : ''}
You are a web designer. Be specific, concise, not salesy. Write only the message.`;
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-20250514', max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      return res.json({ script: r.data.content.map(c => c.text||'').join('').trim() });
    } catch(e) { /* fall through to template */ }
  }

  // Template fallback — no API key needed
  res.json({ script: generateOutreachTemplate(lead, type) });
});

// ─── Serve frontend for all other routes ─────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎯 LeadRadar running at http://localhost:${PORT}`);
  if (!GOOGLE_KEY || GOOGLE_KEY === 'your_google_places_api_key_here') {
    console.warn('⚠️  No Google Places API key set — add it to .env (copy from .env.example)');
  } else {
    console.log('✅ Google Places API key loaded');
  }
});
