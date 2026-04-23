# Middle East × Oil Dashboard

A single-page dashboard with:
- Live **Brent (BZ=F)** and **WTI (CL=F)** prices, refreshed every 2 minutes.
- Interactive price chart (1D / 5D / 1M) for either contract.
- Curated **news feed** on Iran–US–Israel and Middle East events, with a separate
  **oil-impact** filter surfacing OPEC / Hormuz / sanctions / refinery stories.
- Mobile-first layout.

## Architecture

Deployed on **Vercel**. Two tiny serverless functions sidestep CORS:

- `GET /api/prices?symbol=BZ=F&range=1d` → proxies Yahoo Finance's chart endpoint.
- `GET /api/news` → pulls two Google News RSS queries, merges, and flags oil-impact items.

The static `index.html` polls those endpoints from the browser.

## Deploy

```
npx vercel login      # one-time, browser auth
npx vercel --prod     # first-run wizard picks a project name; redeploys are one command
```

No env vars, no keys, no database.
