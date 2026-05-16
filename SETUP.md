# ApplyPilot — Setup Guide

**By Shivam Singh** — [github.com/ShivUP32/job-hunt-agent](https://github.com/ShivUP32/job-hunt-agent)

AI job scoring (Groq) + cover letters + Google Sheets tracking + scheduler

---

## Step 1 — Clone & install

```bash
git clone https://github.com/ShivUP32/job-hunt-agent.git
cd job-hunt-agent

pip install -r requirements.txt
```

---

## Step 2 — Fill in config.py

```bash
cp example.config config.py
```

Open `config.py` and fill in:

| Section | What to set |
|---|---|
| `PERSONAL` | Your name, email, phone, LinkedIn URL |
| `LINKEDIN/NAUKRI/etc` | Your login credentials |
| `SEARCH.keywords` | Your target job titles |
| `SEARCH.location` | "India" or specific city |
| `EXPERIENCE` | Years, current/expected CTC |
| `AI.groq_api_key` | Free key from console.groq.com |
| `AI.resume_text` | Plain text copy of your CV |
| `AI.min_match_score` | 70 = only apply to 70%+ matches |

> **Tip:** Use the web UI (`python backend/server.py` + `cd frontend && npm run dev`) to fill config from a browser instead of editing `config.py` directly.

---

## Step 3 — Get your Groq API key (free, no credit card)

1. Go to **console.groq.com**
2. Sign in with Google
3. API Keys → Create API Key → name it "applypilot"
4. Copy the `gsk_...` key → paste into the web UI or `config.py` → `AI.groq_api_key`

---

## Step 4 — Set up Google Sheets tracker

1. Create a new Google Sheet at sheets.google.com
2. Share the sheet with **itsshiv555@gmail.com** with **Editor** access
3. Copy the sheet URL and paste it into the web UI (Google Sheet Setup section)

ApplyPilot will automatically log every application to your sheet.

---

## Step 5 — Run

```bash
# Interactive menu (choose platform)
python main.py

# Run all platforms at once
python main.py --auto

# Run specific platforms
python main.py --platforms linkedin,naukri

# Run daily at 9am automatically (keep terminal open)
python main.py --schedule
```

---

## How AI scoring works

Before applying to any job, the bot calls `system_config.score_job(title, description)`.
If the score is below `config.AI['min_match_score']` (default 70), the job is skipped
and logged to Sheets as "Skipped (score)" so you can see what was filtered.

---

## Cover letters

For LinkedIn Easy Apply modals that contain a "cover letter" or "motivation" textarea,
the bot automatically generates and injects a personalised cover letter using Groq —
tailored to the specific job title and company. No action needed from you.
