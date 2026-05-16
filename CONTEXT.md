# ApplyPilot — Session Context

Use this file to onboard a new Claude Code session. Delete it after reading.

---

## Project

**ApplyPilot** — AI-powered job application agent.
Automates applying to LinkedIn, Naukri, Indeed, Glassdoor, Foundit using Selenium + Groq AI.

- **Live UI:** https://job-hunt-agent-iota.vercel.app (Vercel, auto-deploys from GitHub)
- **GitHub:** https://github.com/ShivUP32/job-apply-agent (active repo)
- **Local (Mac):** `~/Desktop/job-hunt-agent-mvp` — this is the working directory
- **Old repo** `job-hunt-agent` has been deleted/replaced by `job-apply-agent`

---

## Architecture

```
Vercel UI (React)  ──HTTPS──►  Local FastAPI backend (port 8000)  ──►  Bot processes
                                     backend/server.py                  linkedin_bot.py
                                                                        naukri_bot.py
                                                                        indeed_bot.py
                                                                        glassdoor_bot.py
                                                                        foundit_bot.py
```

- **Frontend:** `frontend/src/App.jsx` (single React file, Vite)
- **Backend:** `backend/server.py` (FastAPI, runs locally on Mac)
- **AI layer:** `system_config.py` (Groq scoring + cover letters — renamed from `ai_engine.py`)
- **Config template:** `example.config` (renamed from `config.example.py`)
- **ChromeDriver:** `driver_utils.py` — auto-installs, unblocks on macOS/Windows, retries on version mismatch
- **Sheets logger:** `sheets_logger.py` — logs each application to Google Sheets (fire-and-forget thread)

---

## Key Decisions Made

| Decision | Detail |
|----------|--------|
| `ai_engine.py` renamed to `system_config.py` | All bots import via `import system_config as ai_engine` so call sites unchanged |
| `config.example.py` renamed to `example.config` | Not imported anywhere, just a template |
| Each bot has its own Chrome profile dir | `chrome_profile/linkedin`, `chrome_profile/naukri`, etc. — prevents blank tabs on concurrent runs |
| `driver_utils.create_driver(options)` | Catches `SessionNotCreatedException`, clears `~/.wdm`, re-downloads ChromeDriver, retries once |
| Stability flags added | `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu` added automatically |
| RayeesYousufGenAi removed | All commits rewritten via `git filter-repo`, force-pushed. GitHub contributor graph will update within 24–48h |
| Git history squashed | Entire history squashed into single commit "Initial release — ApplyPilot v1.0" dated 2026-05-16 |
| Google Sheets | Users share sheet with `itsshiv555@gmail.com` (Editor). No Apps Script needed from user side |
| Backend binds to `127.0.0.1` | Changed from `0.0.0.0` — use `BIND_HOST` env var to override |

---

## Active Branch

**`claude/enable-ai-scoring-7eRGU`** — this is the working branch. PR #1 is open against `main`.

Latest commits on this branch:
- `1fc582e` — Fix race condition, CORS, and remaining server.py vulnerabilities
- `d2acbac` — QA audit: fix critical bugs and security vulnerabilities
- `dbb082a` — Redact local paths from log stream and fix banner repo link

---

## QA Audit Completed — All Fixed

A full pre-release QA + security audit was run. All findings have been fixed and pushed. Summary:

### Security (server.py)
| Fix | Detail |
|-----|--------|
| Path redaction | `_sanitise()` strips home dir + BOT_DIR from all log lines before sending to UI |
| Redaction order bug fixed | Prefixes sorted longest-first so BOT_DIR is matched before home dir |
| `/health` no longer exposes `bot_dir` | Removed from response |
| `/run` start log sanitised | Shows `▶ Starting ApplyPilot — naukri, linkedin` not raw command with paths |
| `/save-profile` no longer returns `config_path` | Was leaking full filesystem path |
| Exception messages sanitised | `str(e)` replaced with generic messages — no more path leaks via 500 errors |
| Race condition fixed | `_run_lock` guards entire check-and-launch in `/run` and `/stop` |
| `_stream_process` generation check | Only clears `RUNNING` when `PROCESS is proc` — prevents stale thread resetting state |
| CORS narrowed | `allow_credentials=False`, methods limited to GET/POST, headers to Content-Type |
| Backend binds to `127.0.0.1` | Use `BIND_HOST` env var to expose on LAN if needed |
| `sheets_webhook_url` validated | Must start with `https://script.google.com/` |
| `BOT_DIR` validated | Must be inside home directory — raises `RuntimeError` at startup if not |
| Input bounds | `min_match_score` 0–100, `max_applications` 1–500, `experience_years` 0–50, `experience_months` 0–11 |
| DoS prevention | `resume_text` max 100,000 chars, `target_roles` max 20 items |
| `ScheduleRequest.interval` typed | `Literal["daily_9am","twice_daily","weekdays","manual"]` — prevents future injection |
| Dead code removed | `background_tasks` param removed from `/run`; unused `asyncio`, `Optional` imports removed |

### Bot Logic (naukri_bot.py, linkedin_bot.py)
| Fix | Detail |
|-----|--------|
| **False "Applied" marking** (Critical) | Modal fill failure no longer marks job as Applied — `submitted` flag gates all success actions |
| Driver leak fixed | `driver = None` before try; `if driver is not None: driver.quit()` in finally |
| Max-page guard | Both bots stop pagination at `config.SEARCH.get("max_pages", 20)` |
| Duplicate `logging.basicConfig` | Removed from `linkedin_bot.py` module level — root logger owned by `main.py` |

### AI Scoring (system_config.py)
| Fix | Detail |
|-----|--------|
| Parse error sentinel | Returns `score=-1` (not `score=50`) on failure — callers skip the job instead of applying blindly |
| All callers updated | `main.py`, `linkedin_bot.py`, `naukri_bot.py` all handle `score=-1` consistently |

### Startup (main.py)
| Fix | Detail |
|-----|--------|
| Pre-flight config check | `importlib.find_spec("config")` before any import — exits with a clear message if `config.py` missing |

### Sheets Logger (sheets_logger.py)
| Fix | Detail |
|-----|--------|
| Fire-and-forget | HTTP POST now runs in a `daemon=True` thread — no longer blocks bot threads for 8s per application |
| `sheet_url` guard removed | Was silently killing logging for valid single-sheet webhook configs |

---

## Remaining Known Gaps (Not Yet Fixed — Frontend/Env)

- **`VITE_SHEETS_WEBHOOK_SECRET`** in Vercel env vars is compiled into the JS bundle — move secrets server-side only
- **`VITE_API_URL`** should be forced to `https://` — HTTP fallback causes mixed-content failures on Vercel
- **`config.py` permissions** — secrets (Groq key, webhook secret) written to disk without `0o600` permissions

---

## Running Locally

```bash
# Kill anything on port 8000
lsof -ti:8000 | xargs kill -9

# Backend
cd ~/Desktop/job-hunt-agent-mvp
python3 backend/server.py

# Frontend (new terminal)
cd ~/Desktop/job-hunt-agent-mvp/frontend
npm install && npm run dev
```

---

## Environment Variables

**Vercel** (set in Vercel dashboard):

| Variable | Purpose |
|----------|---------|
| `VITE_SHEETS_WEBHOOK_URL` | Central Google Apps Script webhook URL |
| `VITE_SHEETS_WEBHOOK_SECRET` | Webhook auth secret (move server-side — see known gaps) |

**Local** (`frontend/.env.local` — not committed):

```
VITE_SHEETS_WEBHOOK_URL=https://script.google.com/...
VITE_SHEETS_WEBHOOK_SECRET=your_secret
```

**Backend env vars:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOT_DIR` | `~/Desktop/job-hunt-agent` | Path to bot directory |
| `BIND_HOST` | `127.0.0.1` | Host to bind FastAPI server |
| `ALLOWED_ORIGINS` | `*` | CORS origins (set to Vercel URL in production) |

---

## File Structure

```
job-hunt-agent-mvp/
├── main.py                  ← CLI entry + scheduler
├── system_config.py         ← Groq AI (scoring, cover letters, Q&A)
├── sheets_logger.py         ← Google Sheets webhook logger (fire-and-forget)
├── driver_utils.py          ← ChromeDriver setup + auto-recovery
├── example.config           ← Config template (copy → config.py)
├── config.py                ← Generated by UI (gitignored)
├── linkedin_bot.py
├── naukri_bot.py
├── indeed_bot.py
├── glassdoor_bot.py
├── foundit_bot.py
├── backend/
│   ├── server.py            ← FastAPI backend
│   └── requirements.txt
├── frontend/
│   ├── src/App.jsx          ← Entire React UI (single file)
│   ├── src/main.jsx
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── README.md
├── SETUP.md
└── CONTEXT.md               ← This file (delete after reading)
```

---

## Known Issues

- `Built on: multi-platform-job-apply-bot (MIT)` still appears in logs if running from the **old** `~/Desktop/job-hunt-agent` folder. Always run from `~/Desktop/job-hunt-agent-mvp`.
- GitHub Contributors panel may still show `RayeesYousufGenAi` for up to 48h — git history is already clean, just a cache delay.
- Local repo `~/Desktop/job-hunt-agent-mvp` needs to be updated by pulling from GitHub (Claude runs in cloud, cannot push to local).
