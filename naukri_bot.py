"""
naukri_bot.py — ApplyPilot
By Shivam Singh — github.com/ShivUP32/job-hunt-agent
+ AI scoring before each apply
+ Google Sheets logging after each apply
          + AI-powered cover letter for apply modal
          + AI answer_question() fallback for unknown questions
"""

import logging
import time
import os
import random
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from driver_utils import create_driver
from selenium.webdriver.chrome.options import Options

import config
import system_config as ai_engine
import sheets_logger

log = logging.getLogger(__name__)


def get_driver():
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    user_data_dir = os.path.join(os.getcwd(), "chrome_profile", "naukri")
    options.add_argument(f"user-data-dir={user_data_dir}")
    return create_driver(options)


def naukri_login(driver):
    log.info("Naukri login...")
    driver.get("https://login.naukri.com/nLogin/Login.php")
    print("\n" + "="*60)
    print("🤖 [ACTION REQUIRED]")
    print("Login to Naukri in the Chrome window (OTP/CAPTCHA if needed).")
    input("👉 Press ENTER when fully logged in... ")
    print("="*60 + "\n")
    log.info("✅ Naukri login confirmed.")


def search_jobs(driver, keyword):
    log.info(f"Searching Naukri: '{keyword}'")
    loc = config.SEARCH.get("location", "india").replace(" ", "-").lower()
    if config.SEARCH.get("remote_only"):
        url = f"https://www.naukri.com/remote-{keyword.replace(' ', '-')}-jobs-in-{loc}?jobAge={config.SEARCH['days_since_posted']}"
    else:
        url = f"https://www.naukri.com/{keyword.replace(' ', '-')}-jobs-in-{loc}?jobAge={config.SEARCH['days_since_posted']}"
    driver.get(url)
    time.sleep(5)


# ── Smart Answer Engine (original logic + AI fallback) ────────

def find_answer(question_text: str) -> str:
    """
    1. Try keyword match from SAVED_ANSWERS (original logic, fast).
    2. If no match, try numeric/yes/no fallbacks (original logic).
    3. If still no match, call AI for a contextual answer.
    """
    q = question_text.lower().strip()

    # Original keyword matching
    for keyword, answer in config.SAVED_ANSWERS.items():
        if keyword.lower() in q:
            return str(answer)

    # Original fallbacks
    if any(w in q for w in ["year", "experience", "how long", "how many"]):
        return config.EXPERIENCE.get("total_years", "4")
    if any(w in q for w in ["salary", "ctc", "compensation", "pay"]):
        return config.EXPERIENCE.get("expected_salary", "2500000")
    if any(w in q for w in ["notice", "join", "start", "available"]):
        return config.WORK_AUTH.get("notice_period", "30 days")
    if any(w in q for w in ["yes", "no", "are you", "do you", "have you", "can you"]):
        return "Yes"

    # AI fallback for genuinely unknown questions
    log.info(f"  → AI answering: {question_text[:60]}...")
    return ai_engine.answer_question(question_text)


def human_type(element, text):
    for char in str(text):
        try:
            element.send_keys(char)
            time.sleep(random.uniform(0.01, 0.05))
        except Exception:
            pass


def fill_field(field, answer):
    try:
        tag = field.tag_name.lower()
        field_type = field.get_attribute("type") or ""
        if tag == "select":
            sel = Select(field)
            try:
                sel.select_by_visible_text(answer)
            except Exception:
                for opt in sel.options:
                    if answer.lower() in opt.text.lower():
                        sel.select_by_visible_text(opt.text)
                        break
        elif field_type in ["radio", "checkbox"]:
            if not field.is_selected():
                try:
                    field.find_element(By.XPATH, "./following-sibling::label | ./parent::label").click()
                except Exception:
                    field.click()
        elif tag in ["input", "textarea"]:
            if field_type not in ["file", "submit", "button", "hidden"]:
                if not field.get_attribute("value"):
                    field.clear()
                    human_type(field, answer)
    except Exception:
        pass


def apply_to_job(driver, job_card, applied_titles: set) -> bool:
    try:
        # ── Get job title + URL ──────────────────────────────
        try:
            title_el  = job_card.find_element(By.CSS_SELECTOR, "a.title")
            job_title = title_el.text.strip()
            job_url   = title_el.get_attribute("href")
        except Exception:
            job_title = "Unknown Naukri Role"
            job_url   = None

        if job_title in applied_titles:
            return False
        if not job_url:
            return False

        # ── AI Scoring ───────────────────────────────────────
        try:
            desc_el = job_card.find_element(By.CSS_SELECTOR, ".job-description, .jd-desc")
            jd_text = desc_el.text[:800]
        except Exception:
            jd_text = job_title

        try:
            co_el   = job_card.find_element(By.CSS_SELECTOR, ".subTitle a, .comp-name")
            company = co_el.text.strip()
        except Exception:
            company = "Unknown"

        passes, score, reason = _should_apply(job_title, jd_text)
        if not passes:
            log.info(f"  ✗ Skipped (score {score}%): {job_title}")
            sheets_logger.log_application(
                platform="Naukri", job_title=job_title, company=company,
                job_url=job_url, status="Skipped (score)", match_score=score
            )
            return False

        log.info(f"📋 Applying [{score}%]: {job_title} @ {company}")

        # ── Open job in new tab ──────────────────────────────
        driver.execute_script(f"window.open('{job_url}', '_blank');")
        time.sleep(2)
        driver.switch_to.window(driver.window_handles[-1])
        wait = WebDriverWait(driver, 10)

        # ── Find apply button ─────────────────────────────────
        apply_btn = wait.until(EC.element_to_be_clickable(
            (By.CSS_SELECTOR, "button.apply-message, #apply-button, .apply-button")
        ))

        if "Already Applied" in apply_btn.text:
            log.info(f"  ⏭ Already applied: {job_title}")
            driver.close()
            driver.switch_to.window(driver.window_handles[0])
            return False

        apply_btn.click()
        time.sleep(3)

        # ── Fill apply modal ─────────────────────────────────
        try:
            chat_inputs = driver.find_elements(
                By.XPATH,
                "//div[contains(@class,'chatbot')]//input[not(@type='hidden')] | "
                "//div[contains(@class,'apply-form')]//input[not(@type='hidden')] | "
                "//div[contains(@class,'apply-form')]//select"
            )
            for inp in chat_inputs:
                try:
                    q_el   = inp.find_element(By.XPATH, "./parent::div/preceding-sibling::div[contains(@class,'botMsg')] | ./preceding::label[1]")
                    q_text = q_el.text
                except Exception:
                    q_text = "unknown"
                fill_field(inp, find_answer(q_text))
                time.sleep(0.5)

            submit_btn = driver.find_element(
                By.XPATH,
                "//button[contains(text(),'Submit') or contains(text(),'Update and Apply') or contains(text(),'Send')]"
            )
            submit_btn.click()
            time.sleep(2)
        except Exception:
            pass

        log.info(f"  ✅ Applied: {job_title}")
        applied_titles.add(job_title)

        # ── Log to Google Sheets ─────────────────────────────
        sheets_logger.log_application(
            platform="Naukri", job_title=job_title, company=company,
            job_url=job_url, status="Applied", match_score=score
        )

        driver.close()
        driver.switch_to.window(driver.window_handles[0])
        return True

    except Exception as e:
        log.error(f"Naukri apply error: {e}")
        if len(driver.window_handles) > 1:
            driver.close()
            driver.switch_to.window(driver.window_handles[0])
        return False


def _should_apply(job_title: str, jd: str) -> tuple:
    """Wrapper that only scores if AI is enabled."""
    min_score = config.AI.get("min_match_score", 0)
    if not config.AI.get("enabled", True) or min_score == 0:
        return True, 0, "AI off"
    result = ai_engine.score_job(job_title, jd)
    score  = result.get("score", 50)
    return score >= min_score, score, result.get("reason", "")


def run_naukri_bot():
    log.info("─── NAUKRI BOT STARTED ───")
    driver        = get_driver()
    applied_titles = set()
    total_applied  = 0
    max_apps       = config.SEARCH["max_applications"]

    try:
        naukri_login(driver)

        for keyword in config.SEARCH["keywords"]:
            if total_applied >= max_apps:
                break
            search_jobs(driver, keyword)
            page_clicks = 0

            while total_applied < max_apps:
                # Scroll to load cards
                for _ in range(3):
                    driver.execute_script("window.scrollBy(0, 1000)")
                    time.sleep(1)

                cards = driver.find_elements(By.CSS_SELECTOR, ".srp-jobtuple-wrapper, .jobTuple")
                log.info(f"  {len(cards)} cards found (page {page_clicks+1})")
                if not cards:
                    break

                for card in cards:
                    if total_applied >= max_apps:
                        break
                    if apply_to_job(driver, card, applied_titles):
                        total_applied += 1
                    time.sleep(random.uniform(1.5, 3.5))

                # Next page
                try:
                    nxt = driver.find_element(By.XPATH, "//a[contains(@class,'next') or contains(text(),'Next')]")
                    nxt.click()
                    time.sleep(3)
                    page_clicks += 1
                except Exception:
                    break

    except Exception as e:
        log.error(f"Naukri Bot error: {e}")
    finally:
        log.info(f"─── Naukri done: {total_applied} applied ───")
        driver.quit()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_naukri_bot()
