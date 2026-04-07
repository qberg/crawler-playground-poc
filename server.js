import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// Middleware
app.use('/*', cors());

const FC_KEY = process.env.FIRECRAWL_API_KEY;
const OAI_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(level, url, msg) {
  const host = url ? new URL(url).hostname.replace('www.', '') : '—';
  const color = { info: C.blue, success: C.green, warn: C.yellow, error: C.red }[level] || '';
  const icon = { info: '→', success: '✓', warn: '!', error: '✗' }[level] || '·';
  console.log(`${color}${icon}${C.reset} ${C.dim}[${host}]${C.reset} ${msg}`);
}

// ─── Tier detection ───────────────────────────────────────────────────────────

async function detectTier(url) {
  const base = new URL(url).origin;

  if (url.toLowerCase().endsWith('.pdf')) return { tier: 4, label: 'Tier 4 · PDF', rssUrl: null };

  const rssProbes = [
    '/feed',
    '/rss',
    '/feed.xml',
    '/rss.xml',
    '/atom.xml',
    '/feeds/posts/default',
    '/news/rss',
  ].map((p) => base + p);

  for (const rssUrl of rssProbes) {
    try {
      const r = await fetch(rssUrl, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrawlerPlayground/1.0)' },
      });
      if (r.ok) {
        const text = await r.text();
        if (text.includes('<rss') || text.includes('<feed') || text.includes('<channel'))
          return { tier: 1, label: 'Tier 1 · RSS', rssUrl };
      }
    } catch {}
  }

  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrawlerPlayground/1.0)' },
    });
    const html = await r.text();

    const rssMatch =
      html.match(/type="application\/rss\+xml"[^>]*href="([^"]+)"/i) ||
      html.match(/href="([^"]+)"[^>]*type="application\/rss\+xml"/i) ||
      html.match(/type="application\/atom\+xml"[^>]*href="([^"]+)"/i);

    if (rssMatch) {
      const rssUrl = rssMatch[1].startsWith('http') ? rssMatch[1] : base + rssMatch[1];
      return { tier: 1, label: 'Tier 1 · RSS', rssUrl };
    }

    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .trim();
    const wordCount = stripped.split(/\s+/).filter((w) => w.length > 3).length;

    return wordCount < 60
      ? { tier: 3, label: 'Tier 3 · JS rendered', rssUrl: null }
      : { tier: 2, label: 'Tier 2 · HTML', rssUrl: null };
  } catch {
    return { tier: 3, label: 'Tier 3 · JS rendered', rssUrl: null };
  }
}

// ─── Article discovery ────────────────────────────────────────────────────────

async function discoverArticles(sourceUrl, tier, rssUrl, limit = 8) {
  if (tier === 1 && rssUrl) {
    log('info', sourceUrl, `Fetching RSS → ${rssUrl}`);
    try {
      const r = await fetch(rssUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrawlerPlayground/1.0)' },
      });
      const xml = await r.text();
      const links = [...xml.matchAll(/<link>([^<]+)<\/link>/gi)]
        .map((m) => m[1].trim())
        .filter((u) => u.startsWith('http') && u !== sourceUrl)
        .slice(0, limit);
      if (links.length) {
        log('success', sourceUrl, `Found ${links.length} articles via RSS`);
        return links;
      }
    } catch (e) {
      log('warn', sourceUrl, `RSS fetch failed: ${e.message}`);
    }
  }

  log('info', sourceUrl, 'Discovering articles via Firecrawl map...');
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + FC_KEY },
      body: JSON.stringify({ url: sourceUrl, limit: 30 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Firecrawl map ${r.status}`);
    const data = await r.json();
    const links = (data.links || []).filter((u) => isLikelyArticle(u)).slice(0, limit);
    log('success', sourceUrl, `Found ${links.length} article links via map`);
    return links;
  } catch (e) {
    log('error', sourceUrl, `Map failed: ${e.message}`);
    return [];
  }
}

function isLikelyArticle(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const junkPatterns = [
      /\/(tag|tags|category|categories|author|authors|page|search|about|contact|privacy|terms)\//,
      /\.(jpg|jpeg|png|gif|svg|css|js|pdf|xml|json)$/,
      /\/#/,
    ];
    if (junkPatterns.some((p) => p.test(path))) return false;
    const segments = path.split('/').filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

// ─── Extraction ───────────────────────────────────────────────────────────────

async function extractArticle(url, tier) {
  const body = { url, formats: ['markdown'], onlyMainContent: true };
  if (tier === 3) body.waitFor = 2000;

  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + FC_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!r.ok) throw new Error(`Firecrawl ${r.status}`);
  const data = await r.json();
  if (!data.success) throw new Error(data.error || 'Firecrawl returned success:false');

  const md = data.data?.markdown || '';
  const meta = data.data?.metadata || {};
  const wordCount = md.split(/\s+/).filter((w) => w.length > 2).length;

  return {
    markdown: md.slice(0, 4000),
    title: meta.title || meta.ogTitle || '',
    description: meta.description || '',
    wordCount,
    qualityScore: Math.min(10, Math.round((wordCount / 200) * 10)),
    heroImage: meta.ogImage || meta.image || '',
    publishedAt: meta.publishedTime || meta.ogArticlePublishedTime || null,
  };
}

// ─── NLP ──────────────────────────────────────────────────────────────────────

async function analyzeArticle(url, title, markdown) {
  const prompt = `You are analyzing a news article for a Tamil Nadu startup ecosystem intelligence platform.

URL: ${url}
Title: ${title}
Content: ${markdown.slice(0, 2000)}

Return ONLY valid JSON, no markdown:
{
  "keywords": ["kw1","kw2","kw3","kw4","kw5"],
  "entities": [{"name":"EntityName","type":"ORG|PERSON|LOCATION|FUNDING"}],
  "relevanceScore": 7,
  "relevanceReason": "one sentence",
  "topicSummary": "5 word max topic label",
  "eventType": "funding|policy|product|profile|other"
}

relevanceScore 0-10: relevance to Tamil Nadu startup ecosystem.
entities max 5, keywords exactly 5.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OAI_KEY },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// ─── Clustering ───────────────────────────────────────────────────────────────

async function clusterArticles(articles) {
  const summaries = articles
    .map(
      (a, i) =>
        `${i}: "${a.extraction.title}" — keywords: ${a.nlp.keywords.join(', ')} — topic: ${a.nlp.topicSummary} — event: ${a.nlp.eventType}`
    )
    .join('\n');

  const prompt = `You are grouping news articles into Stories for a media intelligence platform.
A Story = multiple articles covering the same real-world event or topic.

Articles:
${summaries}

Return ONLY valid JSON, no markdown:
{
  "stories": [
    {
      "title": "Story title (clear, journalistic, max 10 words)",
      "indices": [0, 2, 4],
      "confidence": 0.85,
      "reason": "one sentence why these are the same story"
    }
  ]
}

Rules:
- Every index must appear in exactly one story
- Group articles about the SAME event together, not just the same topic
- Solo articles that don't match any other article get their own story
- confidence: 0-1, how sure you are these cover the same event
- Aim for tight clusters — prefer more stories over forcing unrelated articles together`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OAI_KEY },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) throw new Error(`OpenAI cluster ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/discover', async (c) => {
  try {
    const { url } = await c.req.json();
    if (!url) return c.json({ error: 'url required' }, 400);

    log('info', url, 'Detecting tier...');
    const tier = await detectTier(url);
    log('success', url, tier.label);

    const articles = await discoverArticles(url, tier.tier, tier.rssUrl);
    return c.json({ tier, articles });
  } catch (e) {
    log('error', '—', e.message);
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/analyze', async (c) => {
  try {
    const { url, tier } = await c.req.json();
    if (!url) return c.json({ error: 'url required' }, 400);

    const result = { url, extraction: null, nlp: null, error: null };

    try {
      log('info', url, 'Extracting...');
      result.extraction = await extractArticle(url, tier || 2);
      log(
        'success',
        url,
        `${result.extraction.wordCount} words · quality ${result.extraction.qualityScore}/10`
      );

      log('info', url, 'Analyzing...');
      result.nlp = await analyzeArticle(url, result.extraction.title, result.extraction.markdown);
      log(
        'success',
        url,
        `relevance ${result.nlp.relevanceScore}/10 · "${result.nlp.topicSummary}"`
      );
    } catch (e) {
      result.error = e.message;
      log('error', url, e.message);
    }

    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/cluster', async (c) => {
  try {
    const { articles } = await c.req.json();
    const good = articles.filter((a) => a.nlp && !a.error);
    if (good.length < 2) return c.json({ stories: [] });

    log('info', null, `Clustering ${good.length} articles into proto-stories...`);
    const result = await clusterArticles(good);
    log('success', null, `${result.stories.length} proto-stories formed`);

    return c.json({ stories: result.stories, articles: good });
  } catch (e) {
    log('error', null, e.message);
    return c.json({ error: e.message }, 500);
  }
});

// ─── Bootstrapping ────────────────────────────────────────────────────────────
export default app;
