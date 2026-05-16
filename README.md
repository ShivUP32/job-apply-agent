# ApplyPilot

> Apply to hundreds of jobs while you sleep.

ApplyPilot is an AI-powered job application agent. Point it at your target roles, walk away, and come back to a Google Sheet full of applications — each one scored, filled, and submitted automatically across LinkedIn, Naukri, Indeed, Glassdoor, and Foundit.

**Live UI → [job-hunt-agent-iota.vercel.app](https://job-hunt-agent-iota.vercel.app)**

---

## What it does

- Opens Chrome, logs into job portals, and searches for your target roles
- Scores each job against your resume using Groq AI — skips poor matches
- Fills every form field: text, dropdowns, radio buttons, checkboxes
- Uploads your resume and generates a tailored cover letter per job
- Logs every application to a Google Sheet in real time

---

## Platforms

| | Platform | Method |
|---|---|---|
| 🔵 | LinkedIn | Easy Apply |
| 🔵 | Naukri | Quick Apply |
| 🔵 | Indeed | SmartApply |
| 🔵 | Glassdoor | Easy Apply |
| 🔵 | Foundit (Monster India) | Apply |

---

## Getting started

**Requirements:** Python 3.8+, Google Chrome

```bash
git clone https://github.com/ShivUP32/job-hunt-agent.git
cd job-hunt-agent
pip install -r requirements.txt
```

**Option A — Web UI (recommended)**

Open [job-hunt-agent-iota.vercel.app](https://job-hunt-agent-iota.vercel.app), fill in your profile, and hit Run. The UI talks to a local backend you start with:

```bash
python backend/server.py
```

**Option B — CLI**

```bash
cp example.config config.py
# edit config.py with your details
python main.py
```

---

## CLI flags

```bash
python main.py                          # interactive menu
python main.py --auto                   # run all 5 platforms
python main.py --platforms linkedin,naukri   # specific platforms
python main.py --schedule              # run daily at 9 AM
```

---

## How the AI works

Before applying to any job, ApplyPilot sends the job title + description to Groq and gets back a match score (0–100) based on your resume. Jobs below your threshold (default 70%) are skipped and logged as "Skipped" in your sheet. For LinkedIn Easy Apply, it also generates a personalised cover letter per role.

---

## Google Sheets tracking

Share your Google Sheet with **itsshiv555@gmail.com** (Editor), paste the sheet URL into the UI, and every application is logged automatically:

| Date | Company | Role | Platform | Match % | Status |
|------|---------|------|----------|---------|--------|
| 2026-05-16 | Razorpay | Backend Engineer | LinkedIn | 88% | Applied |
| 2026-05-16 | Flipkart | Python Developer | Naukri | 74% | Applied |

---

## Project structure

```
job-hunt-agent/
├── main.py              ← CLI entry point
├── example.config    ← config template
├── linkedin_bot.py      ← LinkedIn automation
├── naukri_bot.py        ← Naukri automation
├── indeed_bot.py        ← Indeed automation
├── glassdoor_bot.py     ← Glassdoor automation
├── foundit_bot.py       ← Foundit automation
├── system_config.py         ← Groq scoring + cover letters
├── sheets_logger.py     ← Google Sheets logger
├── driver_utils.py      ← ChromeDriver auto-setup
├── backend/server.py    ← FastAPI (config + bot runner)
└── frontend/            ← React web UI
```

---

## Notes

- Log into each platform once when prompted — Chrome remembers sessions per platform
- Solve any CAPTCHAs manually; the bot waits for you
- Keep `max_applications` at 20–30/session to avoid rate limits
- ChromeDriver updates automatically if your Chrome version changes

---

Built by [Shivam Singh](https://github.com/ShivUP32)
