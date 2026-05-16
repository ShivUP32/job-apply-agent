"""
main.py — ApplyPilot
By Shivam Singh — github.com/ShivUP32/job-hunt-agent
AI job scoring (Groq), Google Sheets logging, scheduled auto-run.

Usage:
  python main.py               # interactive menu (original behaviour)
  python main.py --auto        # run all platforms non-interactively
  python main.py --schedule    # run daily at 9am automatically
"""

import os
import sys
import time
import logging
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import config
import system_config as ai_engine
import sheets_logger

# ── Logging ──────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [APPLYPILOT] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(f"applypilot_{datetime.now().strftime('%Y%m%d')}.log")
    ]
)
log = logging.getLogger(__name__)


# ═══════════════════════ BANNER ═══════════════════════════════

def print_banner():
    print("\n" + "="*62)
    print("   ✈  APPLYPILOT — Auto Job Apply Agent")
    print("   By Shivam Singh — github.com/ShivUP32/job-hunt-agent")
    print("   + Groq AI scoring  + Google Sheets tracking")
    print("="*62)
    print("1.  LinkedIn Bot    (Easy Apply)")
    print("2.  Indeed Bot      (SmartApply)")
    print("3.  Naukri Bot      (India #1)")
    print("4.  Glassdoor Bot   (With company insights)")
    print("5.  Foundit Bot     (ex-Monster India)")
    print("6.  Run ALL Concurrently")
    print("7.  AI Score a single job (test)")
    print("8.  View today's applied jobs")
    print("="*62)


# ═══════════════════════ AI SCORING WRAPPER ═══════════════════

def should_apply(job_title: str, job_description: str = "", company: str = "") -> tuple[bool, int, str]:
    """
    Returns (should_apply: bool, score: int, reason: str).
    If AI is disabled or min_match_score is 0, always returns True.
    """
    min_score = config.AI.get("min_match_score", 0)
    if not config.AI.get("enabled", True) or min_score == 0:
        return True, 0, "AI scoring disabled"

    result = ai_engine.score_job(job_title, job_description)
    score  = result.get("score", 50)
    reason = result.get("reason", "")

    if score == -1:
        return True, 0, "AI not available"

    passes = score >= min_score
    log.info(f"  AI score: {score}% {'✓' if passes else '✗'} — {reason}")
    return passes, score, reason


# ═══════════════════════ PLATFORM RUNNERS ════════════════════

def run_linkedin():
    try:
        from linkedin_bot import run_linkedin_bot
        log.info("▶ LinkedIn Bot starting...")
        run_linkedin_bot()
    except ImportError as e:
        log.error(f"LinkedIn Bot import failed: {e}")
    except Exception as e:
        log.error(f"LinkedIn Bot error: {e}")

def run_indeed():
    try:
        from indeed_bot import run_indeed_bot
        log.info("▶ Indeed Bot starting...")
        run_indeed_bot()
    except ImportError as e:
        log.error(f"Indeed Bot not found: {e}")

def run_naukri():
    try:
        from naukri_bot import run_naukri_bot
        log.info("▶ Naukri Bot starting...")
        run_naukri_bot()
    except ImportError as e:
        log.error(f"Naukri Bot not found: {e}")

def run_glassdoor():
    try:
        from glassdoor_bot import run_glassdoor_bot
        log.info("▶ Glassdoor Bot starting...")
        run_glassdoor_bot()
    except ImportError as e:
        log.error(f"Glassdoor Bot not found: {e}")

def run_foundit():
    try:
        from foundit_bot import run_foundit_bot
        log.info("▶ Foundit Bot starting...")
        run_foundit_bot()
    except ImportError as e:
        log.error(f"Foundit Bot not found: {e}")

def run_all_concurrently():
    log.info("▶ Running ALL platforms concurrently...")
    bots = [run_linkedin, run_indeed, run_naukri, run_glassdoor, run_foundit]
    with ThreadPoolExecutor(max_workers=5) as executor:
        for bot in bots:
            executor.submit(bot)


# ═══════════════════════ SCHEDULER ═══════════════════════════

def run_scheduler():
    """Run all bots once a day at 9am IST (configurable)."""
    log.info("⏰ Scheduler started — will run daily at 09:00 IST")
    log.info("   Press Ctrl+C to stop")

    while True:
        now = datetime.now()
        # Run at 9:00am
        if now.hour == 9 and now.minute == 0:
            log.info(f"⏰ Scheduled run starting: {now.strftime('%Y-%m-%d %H:%M')}")
            run_all_concurrently()
            # Sleep 61 seconds to avoid double-firing in the same minute
            time.sleep(61)
        else:
            next_9am = now.replace(hour=9, minute=0, second=0)
            if now >= next_9am:
                # Already past 9am today, wait for tomorrow
                import datetime as dt
                next_9am = next_9am + dt.timedelta(days=1)
            secs = (next_9am - now).total_seconds()
            hours_left = int(secs // 3600)
            log.info(f"⏰ Next run in ~{hours_left}h. Sleeping...")
            time.sleep(min(secs, 3600))  # wake up every hour at most


# ═══════════════════════ DAILY LOG VIEWER ═══════════════════

def view_today_log():
    today = datetime.now().strftime("%Y%m%d")
    log_file = f"applied_jobs_{today}.txt"
    if os.path.exists(log_file):
        with open(log_file) as f:
            print(f.read())
    else:
        print(f"No log file for today ({log_file})")


# ═══════════════════════ MAIN ════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="ApplyPilot")
    parser.add_argument("--auto",      action="store_true", help="Run all bots non-interactively")
    parser.add_argument("--schedule",  action="store_true", help="Run daily at 9am automatically")
    parser.add_argument("--platforms", type=str, help="Comma-separated platforms to run: linkedin,naukri,indeed,glassdoor,foundit")
    # Legacy single-platform flags kept for backwards compatibility
    parser.add_argument("--naukri",    action="store_true", help="Run Naukri only")
    parser.add_argument("--linkedin",  action="store_true", help="Run LinkedIn only")
    parser.add_argument("--indeed",    action="store_true", help="Run Indeed only")
    parser.add_argument("--glassdoor", action="store_true", help="Run Glassdoor only")
    parser.add_argument("--foundit",   action="store_true", help="Run Foundit only")
    args = parser.parse_args()

    print_banner()

    # Log AI status
    if config.AI.get("enabled") and not config.AI["groq_api_key"].startswith("gsk_xxx"):
        log.info(f"✅ AI scoring enabled (min match: {config.AI['min_match_score']}%)")
    else:
        log.info("⚠️  AI scoring disabled — will apply to all jobs")

    if config.SHEETS.get("enabled") and "YOUR_DEPLOYMENT_ID" not in config.SHEETS.get("webhook_url",""):
        log.info("✅ Google Sheets logging enabled")
    else:
        log.info("⚠️  Google Sheets not configured — skipping logging")

    _platform_map = {
        "linkedin":  run_linkedin,
        "naukri":    run_naukri,
        "indeed":    run_indeed,
        "glassdoor": run_glassdoor,
        "foundit":   run_foundit,
    }

    # CLI flags
    if args.schedule:
        run_scheduler()
        return
    if args.auto:
        run_all_concurrently()
        return
    if args.platforms:
        selected = [p.strip() for p in args.platforms.split(",") if p.strip() in _platform_map]
        if len(selected) == 1:
            _platform_map[selected[0]]()
        elif len(selected) > 1:
            log.info(f"▶ Running selected platforms: {', '.join(selected)}")
            with ThreadPoolExecutor(max_workers=len(selected)) as executor:
                for p in selected:
                    executor.submit(_platform_map[p])
        return
    # Legacy single flags
    if args.naukri:    run_naukri();    return
    if args.linkedin:  run_linkedin();  return
    if args.indeed:    run_indeed();    return
    if args.glassdoor: run_glassdoor(); return
    if args.foundit:   run_foundit();   return

    # Interactive menu
    choice = input("\nEnter your choice (1-8): ").strip()

    dispatch = {
        "1": run_linkedin,
        "2": run_indeed,
        "3": run_naukri,
        "4": run_glassdoor,
        "5": run_foundit,
        "6": run_all_concurrently,
        "8": view_today_log,
    }

    if choice == "7":
        title = input("Job title: ").strip()
        jd    = input("Paste job description (Enter twice to finish):\n")
        ok, score, reason = should_apply(title, jd)
        print(f"\nScore: {score}%  |  Would apply: {ok}")
        print(f"Reason: {reason}")
    elif choice in dispatch:
        dispatch[choice]()
    else:
        print("Invalid choice.")


if __name__ == "__main__":
    main()
