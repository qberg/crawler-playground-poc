# Crawler Playground

Throwaway end-to-end validation tool. Paste URLs → tier detection → Firecrawl extraction → OpenAI NLP → clustering.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Add your API keys
cp .env.example .env
# Edit .env and fill in your keys

# 3. Start
npm start

# 4. Open browser
open http://localhost:3000
```

## What it does

| Step | What happens |
|------|-------------|
| Tier detection | Probes for RSS feeds, checks if page needs JS. No API cost. |
| Extraction | Calls Firecrawl `/v1/scrape`. Tier 3 gets `waitFor: 2000` for JS render. |
| NLP | Calls `gpt-4o-mini` — keywords, entities, TN relevance score 0-10. |
| Clustering | One final OpenAI call — groups sources by topic similarity. |

Runs 3 URLs in parallel. Terminal shows live logs per URL.

## .env

```
FIRECRAWL_API_KEY=fc-...
OPENAI_API_KEY=sk-...
PORT=3000
```
