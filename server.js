require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FC_KEY = process.env.FIRECRAWL_API_KEY;
const OAI_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', red: '\x1b[31m',
  cyan: '\x1b[36m', bold: '\x1b[1m',
};

function log(level, url, msg) {
  const host = url ? new URL(url).hostname.replace('www.', '') : '';
  const prefix = host ? `${COLORS.dim}[${host}]${COLORS.reset}` : '';
  const color = { info: COLORS.blue, success: COLORS.green, warn: COLORS.yellow, error: COLORS.red }[level] || '';
  const icons = { info: '→', success: '✓', warn: '!', error: '✗' };
  console.log(`${color}${icons[level]}${COLORS.reset} ${prefix} ${msg}`);
}

async function detectTier(url) {
  const u = new URL(url);
  const base = u.origin;

  if (u.pathname.toLowerCase().endsWith('.pdf')) {
    return { tier: 4, label: 'Tier 4 · PDF', rssUrl: null };
  }

  const rssProbes = [
    '/feed', '/rss', '/feed.xml', '/rss.xml',
    '/atom.xml', '/feeds/posts/default', '/news/rss',
  ].map(p => base + p);

  for (const rssUrl of rssProbes) {
    try {
      const r = await fetch(rssUrl, { method: 'GET', timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrawlerPlayground/1.0)' } });
      if (r.ok) {
        const text = await r.text();
        if (text.includes('<rss') || text.includes('<feed') || text.includes('<channel')) {
          return { tier: 1, label: 'Tier 1 · RSS', rssUrl };
        }
      }
    } catch {}
  }

  try {
    const r = await fetch(url, { timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrawlerPlayground/1.0)' } });
    const html = await r.text();

    const rssMatch = html.match(/type="application\/rss\+xml"[^>]*href="([^"]+)"/i)
                  || html.match(/href="([^"]+)"[^>]*type="application\/rss\+xml"/i)
                  || html.match(/type="application\/atom\+xml"[^>]*href="([^"]+)"/i);
    if (rssMatch) {
      const rssUrl = rssMatch[1].startsWith('http') ? rssMatch[1] : base + rssMatch[1];
      return { tier: 1, label: 'Tier 1 · RSS', rssUrl };
    }

    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .trim();
    const wordCount = stripped.split(/\s+/).filter(w => w.length > 3).length;

    if (wordCount < 60) return { tier: 3, label: 'Tier 3 · JS rendered', rssUrl: null };
    return { tier: 2, label: 'Tier 2 · HTML', rssUrl: null };
  } catch {
    return { tier: 3, label: 'Tier 3 · JS rendered', rssUrl: null };
  }
}

async function extractWithFirecrawl(url, tier) {
  const body = { url, formats: ['markdown'], onlyMainContent: true };
  if (tier === 3) body.waitFor = 2000;

  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FC_KEY },
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Firecrawl ${r.status}: ${err.slice(0, 200)}`);
  }

  const data = await r.json();
  if (!data.success) throw new Error(data.error || 'Firecrawl returned success:false');

  const md = data.data?.markdown || '';
  const meta = data.data?.metadata || {};
  const wordCount = md.split(/\s+/).filter(w => w.length > 2).length;
  const qualityScore = Math.min(10, Math.round((wordCount / 200) * 10));

  return {
    markdown: md.slice(0, 4000),
    title: meta.title || '',
    description: meta.description || '',
    wordCount,
    qualityScore,
    heroImage: meta.ogImage || meta.image || '',
  };
}

async function analyzeWithOpenAI(url, title, markdown) {
  const prompt = `You are analyzing a news/media website for a Tamil Nadu startup ecosystem intelligence platform.

URL: ${url}
Title: ${title}
Content (first 2000 chars):
${markdown.slice(0, 2000)}

Return ONLY valid JSON — no markdown, no backticks:
{
  "keywords": ["kw1","kw2","kw3","kw4","kw5"],
  "entities": [{"name":"EntityName","type":"ORG|PERSON|LOCATION|FUNDING"}],
  "relevanceScore": 7,
  "relevanceReason": "one sentence explanation",
  "topicSummary": "5 word max topic label"
}

relevanceScore 0-10: how relevant is this source to Tamil Nadu startup ecosystem news.
entities: max 5 most important. keywords: exactly 5.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OAI_KEY },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
    }),
    timeout: 20000,
  });

  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const data = await r.json();
  const content = data.choices[0].message.content;
  return JSON.parse(content);
}

async function clusterWithOpenAI(results) {
  const summaries = results.map((r, i) =>
    `${i}: ${new URL(r.url).hostname} — keywords: ${r.nlp.keywords.join(', ')} — topic: ${r.nlp.topicSummary} — relevance: ${r.nlp.relevanceScore}/10`
  ).join('\n');

  const prompt = `Group these news sources into topic clusters for a media intelligence system.

${summaries}

Return ONLY valid JSON — no markdown, no backticks:
{
  "clusters": [
    { "label": "Cluster name (5 words max)", "indices": [0, 2] }
  ]
}

Rules:
- Every index must appear in exactly one cluster
- Use 2-5 clusters max
- Label describes the shared topic or source type
- Group by editorial focus, not just by geography`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OAI_KEY },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 400,
    }),
    timeout: 20000,
  });

  if (!r.ok) throw new Error(`OpenAI cluster ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const result = { url, tier: null, extraction: null, nlp: null, error: null };

  try {
    log('info', url, 'Detecting tier...');
    result.tier = await detectTier(url);
    log('success', url, `${result.tier.label}${result.tier.rssUrl ? ' → ' + result.tier.rssUrl : ''}`);

    log('info', url, 'Extracting with Firecrawl...');
    result.extraction = await extractWithFirecrawl(url, result.tier.tier);
    log('success', url, `Extracted ${result.extraction.wordCount} words · quality ${result.extraction.qualityScore}/10`);

    log('info', url, 'Analyzing with OpenAI...');
    result.nlp = await analyzeWithOpenAI(url, result.extraction.title, result.extraction.markdown);
    log('success', url, `Relevance ${result.nlp.relevanceScore}/10 · "${result.nlp.topicSummary}"`);

  } catch (err) {
    result.error = err.message;
    log('error', url, err.message);
  }

  res.json(result);
});

app.post('/api/cluster', async (req, res) => {
  const { results } = req.body;
  const successful = results.filter(r => r.nlp && !r.error);
  if (successful.length < 2) return res.json({ clusters: [] });

  try {
    log('info', null, `Clustering ${successful.length} sources...`);
    const clusters = await clusterWithOpenAI(successful);
    log('success', null, `Got ${clusters.clusters.length} clusters`);
    res.json({ clusters: clusters.clusters, sourceResults: successful });
  } catch (err) {
    log('error', null, `Clustering failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n${COLORS.bold}${COLORS.cyan}Crawler Playground${COLORS.reset}`);
  console.log(`${COLORS.dim}─────────────────────────────${COLORS.reset}`);
  console.log(`${COLORS.green}✓${COLORS.reset} Server running at ${COLORS.cyan}http://localhost:${PORT}${COLORS.reset}`);
  console.log(`${COLORS.dim}Firecrawl key: ${FC_KEY ? FC_KEY.slice(0,8) + '...' : 'MISSING'}${COLORS.reset}`);
  console.log(`${COLORS.dim}OpenAI key:    ${OAI_KEY ? OAI_KEY.slice(0,8) + '...' : 'MISSING'}${COLORS.reset}\n`);
});
