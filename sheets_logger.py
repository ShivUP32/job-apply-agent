"""
sheets_logger.py — ApplyPilot Google Sheets Logger
Posts each application to the central Apps Script webhook.
No external dependencies — uses stdlib urllib only.
"""

import json
import logging
import urllib.request
from datetime import datetime

import config

log = logging.getLogger(__name__)


def log_application(
    platform: str,
    job_title: str,
    company: str,
    job_url: str = "",
    status: str = "Applied",
    match_score: int = 0,
    cover_letter_used: bool = False,
    notes: str = ""
):
    """Fire-and-forget POST to Google Sheets webhook."""
    if not config.SHEETS.get("enabled", False):
        return

    webhook = config.SHEETS.get("webhook_url", "")
    if not webhook or "YOUR_DEPLOYMENT_ID" in webhook:
        log.warning("Sheets webhook URL not configured — skipping log")
        return

    sheet_url = config.SHEETS.get("sheet_url", "")
    if not sheet_url:
        log.warning("Sheets sheet_url not configured — skipping log")
        return

    secret = config.SHEETS.get("webhook_secret", "")

    payload = {
        "secret":             secret,
        "sheet_url":          sheet_url,
        "date":               datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "platform":           platform,
        "job_title":          job_title,
        "company":            company,
        "job_url":            job_url,
        "status":             status,
        "match_score":        match_score,
        "cover_letter_used":  "Yes" if cover_letter_used else "No",
        "notes":              notes,
    }

    try:
        body = json.dumps(payload).encode()
        req  = urllib.request.Request(
            webhook,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if resp.status == 200 and raw.strip() == "ok":
                log.info(f"📊 Sheets: logged '{job_title}' @ {company} → {status}")
            else:
                log.warning(f"Sheets log unexpected response (status={resp.status}): {raw[:200]}")
    except Exception as e:
        log.warning(f"Sheets log failed: {e}")
