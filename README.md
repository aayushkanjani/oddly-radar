# Oddly Radar

See what the sharpest prediction-market traders are buying, live.

- **Top traders:** Polymarket leaderboards by profit or volume, for 24h, 7d and 30d.
- **Wallet pages:** any wallet's open positions, profit and recent trades, with a Share on X button.
- **Whale feed:** every Polymarket and Kalshi trade over $1k–$100k, merged and refreshed every 10 seconds, with a filter by venue. Kalshi fills from one order are combined so big orders aren't missed.
- **Following:** star any trader (☆ in the leaderboard, or Follow on their page) and their latest trades appear in a Following panel on the home page, refreshed every 20 seconds. The list is saved in each visitor's browser, so there are no accounts or databases to set up.
- **Smart money flow:** what the 30 most profitable Polymarket traders this week bought in the last 6 hours, 24 hours or 3 days, ranked by how many of them are buying the same market. Refreshes every 3 minutes.
- **Live ticker and pulse:** a scrolling ticker of whale trades and a live summary of whale volume and the biggest trade.
- **Telegram alerts:** a bot posts new whale trades from both venues to your channel every 15 minutes.
- **Price gaps:** the same question priced differently on Kalshi and Polymarket, found automatically. Each gap shows both prices, the cheaper venue, the locked-in edge before fees, both rule texts side by side, and a Share button. The biggest gap gets a banner at the top of the page.

Everything runs on free tiers. The project has **no dependencies**: plain HTML/JS pages, small serverless functions, and a Node script. You need Node 20 or newer only to run it on your own computer.

## What's inside

| Path | What it does |
| --- | --- |
| `public/` | The website: `index.html` (home), `wallet.html`, `app.js`, `style.css`, `config.js` (your links) |
| `api/` | Serverless functions Vercel runs: `leaderboard`, `whales`, `wallet`, `smart`, `following`, `gaps` |
| `lib/` | Polymarket and Kalshi data clients, shared by the site and the bot. `pairs.js` holds matched markets |
| `bot/whale-alerts.js` | The Telegram bot |
| `.github/workflows/whale-alerts.yml` | Runs the bot every 15 minutes on GitHub Actions, free |
| `scripts/dev-server.js` | Local preview server |
| `test/` | Offline tests (`npm test`) |

## Deploy it for free (about 30 minutes)

### 1. Put the code on GitHub
1. Create a free account at github.com.
2. Click **New repository**, name it `oddly-radar`, keep it **Public** (Actions minutes are unlimited on public repos), and create it.
3. Click **uploading an existing file**, drag in everything from this folder (including the hidden `.github` folder), and commit.
   If you use git: `git init && git add . && git commit -m "Oddly Radar" && git remote add origin <your repo URL> && git push -u origin main`.

### 2. Deploy the website on Vercel
1. Sign up at vercel.com with your GitHub account (the Hobby plan is free).
2. Click **Add New → Project**, pick `oddly-radar`, and click **Deploy**. No settings to change: `vercel.json` already tells Vercel where the pages are.
3. You get a URL like `https://oddly-radar.vercel.app`. Open it and check that the leaderboard and whale feed load.

### 3. Add your links
Edit `public/config.js` on GitHub (pencil icon) and fill in:
- `telegramUrl`: your channel link (step 4)
- `xHandle`: your X username without the @
- `waitlistUrl`: a free Tally or Google Form for the Pro waitlist

Commit, and Vercel redeploys automatically. Buttons stay hidden until their link is set.

### 4. Create the Telegram bot and channel
1. In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts. Copy the **token** it gives you.
2. Create a **public channel** (for example `@oddlyradar`).
3. Open the channel's settings → **Administrators** → add your bot, with permission to post messages.

### 5. Connect the bot to GitHub Actions
In your GitHub repo: **Settings → Secrets and variables → Actions**.
- Under **Secrets**, add:
  - `TELEGRAM_BOT_TOKEN`: the token from BotFather
  - `TELEGRAM_CHAT_ID`: your channel username with the @, e.g. `@oddlyradar`
- Under **Variables**, add:
  - `SITE_URL`: your Vercel URL, so alerts link to your wallet pages
  - `MIN_USD` (optional): smallest trade to alert on, default `10000`

Then open the **Actions** tab, enable workflows if asked, choose **Whale alerts**, and click **Run workflow**.
The **first run only records existing trades** so your channel isn't flooded. Alerts start from the next run, every 15 minutes.

Good to know: GitHub can start scheduled runs a few minutes late, and it pauses schedules in repos with no activity for 60 days. Any commit restarts them.

## Run it on your computer

```bash
npm run dev     # site at http://localhost:3000
npm test        # offline tests
npm run bot     # dry run: prints alerts instead of posting (no token needed)
```

## How price gaps are found

`lib/match.js` pulls Polymarket's 1,000 busiest markets and Kalshi's open events (parlays excluded), then pairs questions that ask the same thing:

- Rare words count for more than common ones ("Iohannis" matters, "win" barely does), and synonyms are folded (Federal Reserve → fed, decrease → cut, 25 basis points → 25 bps).
- Every number must agree: strike prices, basis points and dates. A missing year on one side is allowed.
- Opposite directions never pair (above vs below, cut vs hike), and close dates must be within 10 days when both are near.
- Each market is used once; the best-scoring pair wins.

Results are cached for 10 minutes, and each pair shows its match score. Open `/api/gaps?debug=1` on your site to see near-misses: questions that almost matched, with their scores. That's the quickest way to tune `MATCH_THRESHOLD` in `lib/match.js` if pairs are missing or wrong.

To pin a pair you've checked by hand, add it to `lib/pairs.js` (steps at the top of that file). Hand-checked pairs show as **Verified** and always appear.

## Data sources

All data comes from public APIs, with no keys needed. Endpoints were checked against live responses on 11 Oct 2026:

- Polymarket leaderboard: `data-api.polymarket.com/v2/leaderboard`
- Polymarket trades and positions: `data-api.polymarket.com/trades` and `/positions` (v1; the v2 trades endpoint ignores the wallet filter)
- Polymarket markets: `gamma-api.polymarket.com/markets`
- Kalshi markets: `api.elections.kalshi.com/trade-api/v2/markets`
- Kalshi trades: `api.elections.kalshi.com/trade-api/v2/markets/trades` (anonymous; no trader is shown)

If a venue changes its API, the parsing lives in `lib/polymarket.js` and `lib/kalshi.js`, and `npm test` shows what broke. The whale feed is cached at Vercel's edge for 5 seconds and the page polls every 10 seconds, so a new whale trade shows up within about 15 seconds. Leaderboards are cached for 2 minutes. Truly tick-by-tick updates would need an always-on server holding websocket connections to each venue, which free serverless hosting can't do; that's a good upgrade once the project earns money.

## Before you charge money

- Vercel's free Hobby plan is meant for non-commercial use. Move to a paid plan, or another host, when you launch the Pro plan; check their current terms.
- Oddly Radar is independent and not affiliated with Polymarket or Kalshi. Keep the footer notice, and read each venue's API terms before adding paid features.

## Ideas for next

1. Pro plan: instant alerts, alerts for wallets you follow, full trade history.
2. Auto-post the biggest whale trade of the day to X.
3. Wallet accuracy scores from resolved markets.
4. Share images for wallet pages, so links unfurl with a picture on X.
