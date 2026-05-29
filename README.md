# LeadRadar 🎯

Find local businesses without websites — your next clients are waiting.

A self-hosted clone of SiteSeeker, powered by **Google Places API** + **Claude AI**.

---

## Features

- 🔍 **Real business search** — Google Places API, live data, no mocked results
- 🏆 **Smart scoring** — proprietary algorithm ranks leads by opportunity quality
- 💎 **Hidden gems** — high-rated businesses with few reviews (easiest to close)
- 📋 **Pipeline** — save leads, track status (New → Contacted → Demo → Closed)
- 📝 **Notes** — per-lead notes with timestamps
- ✉️ **Outreach generator** — Claude AI writes personalized cold emails, SMS, call scripts, DMs
- 🗂️ **Server-side persistence** — pipeline survives browser restarts
- ⚡ **1-hour result cache** — avoid burning API quota on repeated searches

---

## Setup (5 minutes)

### 1. Get a Google Places API key
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → **APIs & Services → Enable APIs**
3. Enable **"Places API"** (the classic one)
4. Go to **Credentials → Create API Key**
5. Restrict it to "Places API" for safety

### 2. Install & configure
```bash
# Clone / unzip the project, then:
cd leadradar
npm install

# Copy the env template
cp .env.example .env

# Edit .env and paste your key:
# GOOGLE_PLACES_API_KEY=AIzaSy...
```

### 3. Run
```bash
npm start
# → http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

---

## How it works

```
User searches "plumbers in Austin TX"
        ↓
Express server → Google Places textsearch API
        ↓
For each result → Places Details API (gets website, phone, hours)
        ↓
Filter: no_website = true  (or hidden_gems filter)
        ↓
Score each lead (0–100) based on: no website, rating, review count, has phone
        ↓
Return sorted leads to frontend
        ↓
User saves → pipeline.json (server-side)
User clicks outreach → Claude API generates personalized script
```

---

## Cost estimates

| Service | Free tier | Paid |
|---|---|---|
| Google Places Text Search | $200/mo credit (~400 searches) | $32 per 1000 searches |
| Google Places Details | $200/mo credit (~333 calls) | $17 per 1000 calls |
| Claude (outreach scripts) | — | ~$0.003 per script |

For personal use, the $200/mo Google Maps credit is plenty.

---

## Deploy to the cloud

### Railway (easiest)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set GOOGLE_PLACES_API_KEY=your_key_here
```

### Render
1. Push to GitHub
2. New Web Service → connect repo
3. Build: `npm install` | Start: `node server.js`
4. Add env var `GOOGLE_PLACES_API_KEY`

### VPS (DigitalOcean / Linode)
```bash
git clone your-repo && cd leadradar
npm install
# Set env vars, then:
npx pm2 start server.js --name leadradar
npx pm2 save
```

---

## Extending

- **Add user auth**: drop in `express-session` + bcrypt for multi-user support
- **CRM export**: add a `/api/pipeline/export` route returning CSV
- **Email sending**: integrate Resend or SendGrid to send outreach directly
- **Airtable sync**: POST to Airtable API on pipeline save
- **Webhooks**: trigger Zapier/Make when a lead status changes
- **Pagination**: the API supports `nextPageToken` for 60+ results

---

## File structure

```
leadradar/
├── server.js          ← Express backend (Places API proxy, pipeline, outreach)
├── public/
│   └── index.html     ← Full frontend (vanilla JS, no build step)
├── pipeline.json      ← Auto-created, stores your saved leads
├── .env               ← Your API keys (never commit this)
├── .env.example       ← Template
└── package.json
```
