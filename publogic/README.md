# PubLogic — Deployment Guide

## File structure
```
publogic/
├── functions/
│   └── api/
│       └── analyse.js        ← Server-side Anthropic API call (no CORS issues)
└── public/
    ├── index.html
    ├── css/
    │   └── style.css
    └── js/
        └── app.js
```

## Deploy to Cloudflare Pages

### Step 1 — Upload to GitHub
1. Create a new GitHub repo called `publogic`
2. Upload all files maintaining the folder structure above
3. Commit and push

### Step 2 — Connect to Cloudflare Pages
1. Go to Cloudflare dashboard → Pages → Create a project
2. Connect to GitHub → select the `publogic` repo
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: **public**
4. Click Save and Deploy

### Step 3 — Add your Anthropic API key
1. In Cloudflare Pages → your project → Settings → Environment variables
2. Add variable:
   - Variable name: `ANTHROPIC_API_KEY`
   - Value: your key from console.anthropic.com
   - Set for both Production and Preview environments
3. Click Save and redeploy

### Step 4 — Add your domain
1. Pages → Custom domains → Add custom domain
2. Enter `publogic.com.au` (once registered at VentraIP)
3. Follow DNS instructions

## How it works
- The browser reads and parses all PDF/Excel files locally (no files sent to server)
- Only a compact statistical summary is sent to the server-side function
- The Cloudflare Function calls Anthropic's API securely (API key never exposed to browser)
- Streaming response flows back to the browser in real time
