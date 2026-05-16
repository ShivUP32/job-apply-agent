# ApplyPilot — Deploy Guide
# Frontend → Vercel (free) | Backend → your Mac

## Architecture
Vercel UI  ──POST /save-profile──▶  FastAPI on Mac  ──runs──▶  Selenium bots
           ◀─── /logs /status ───

---

## STEP 1 — Start the backend on your Mac

```bash
# Install backend deps (one time)
pip3 install fastapi uvicorn python-multipart

# Start the server
cd /path/to/job-hunt-ui/backend
python3 server.py
```

You'll see:
  ✅ ApplyPilot backend running at http://localhost:8000
  Bot directory: /Users/yourname/Desktop/job-hunt-agent

Keep this terminal open. The backend must be running for the UI to work.

---

## STEP 2 — Expose your Mac to the internet (for Vercel to reach it)

The Vercel frontend is on the internet. Your Mac is local. You need ngrok to bridge them.

```bash
# Install ngrok (free)
brew install ngrok

# Sign up free at ngrok.com and get your auth token, then:
ngrok config add-authtoken YOUR_TOKEN

# Expose the backend
ngrok http 8000
```

ngrok prints something like:
  Forwarding  https://abc123.ngrok-free.app -> http://localhost:8000

Copy that https URL — you'll need it in Step 4.

---

## STEP 3 — Deploy frontend to Vercel

```bash
# Install Node.js if not installed: nodejs.org/en/download

cd /path/to/job-hunt-ui/frontend
npm install
npm run build      # test it builds locally first

# Install Vercel CLI
npm install -g vercel

# Deploy
vercel
```

Follow the prompts:
- Set up and deploy? Y
- Which scope? (your account)
- Link to existing project? N
- Project name: applypilot
- Directory: ./  (current)
- Build command: npm run build
- Output directory: dist
- Override? N

Vercel gives you a URL like: https://applypilot.vercel.app

---

## STEP 4 — Connect Vercel to your Mac backend

In the Vercel dashboard:
1. Go to your project → Settings → Environment Variables
2. Add:  VITE_API_URL = https://abc123.ngrok-free.app  (your ngrok URL)
3. Redeploy: vercel --prod

---

## STEP 5 — Use it

1. Open https://applypilot.vercel.app
2. Fill Profile tab → Save
3. Pick platforms
4. Press Run now
5. Chrome opens on your Mac → log in once → bot takes over
6. Watch logs in real time in the Logs tab
7. Check Tracker tab for today's applications

---

## Daily routine

Every day before job hunting:
1. Open Terminal
2. Run: cd ~/Desktop/job-hunt-agent/backend && python3 server.py
3. Run in another tab: ngrok http 8000
4. Open your Vercel URL → press Run

For fully automatic (no manual step):
- Add both commands to your Mac's Login Items so they start on boot
- Use --schedule flag: python3 main.py --schedule

---

## Troubleshooting

"backend offline" in the UI:
→ Make sure python3 server.py is running on your Mac

"Cannot connect" on Run:
→ Check ngrok is running and VITE_API_URL in Vercel matches your current ngrok URL
→ Note: free ngrok URLs change each restart — update Vercel env var each time
→ Fix: get a static ngrok domain (free with account) or use paid plan

Chrome doesn't open:
→ The bot runs on YOUR Mac, not Vercel. Make sure Google Chrome is installed.

Bot crashes immediately:
→ Check the Logs tab for the error
→ Most common: config.py not saved yet (fill Profile → Save first)
