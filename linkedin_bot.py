"""
linkedin_bot.py — ApplyPilot
By Shivam Singh — github.com/ShivUP32/job-hunt-agent
+ AI scoring before each apply
+ Google Sheets logging after each apply
          + AI answer_question() fallback
          + AI cover letter injected into textarea fields
"""

import time
import random
import logging
from datetime import datetime
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    NoSuchElementException, TimeoutException,
    ElementNotInteractableException, StaleElementReferenceException
)
from driver_utils import create_driver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
import os

import config
import system_config as ai_engine
import sheets_logger

log = logging.getLogger(__name__)


def sleep(min_s=1.0, max_s=3.0):
    time.sleep(random.uniform(min_s, max_s))


def human_type(element, text):
    element.clear()
    for char in str(text):
        element.send_keys(char)
        time.sleep(random.uniform(0.03, 0.12))


def get_driver():
    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    user_data_dir = os.path.join(os.getcwd(), "chrome_profile", "linkedin")
    options.add_argument(f"user-data-dir={user_data_dir}")
    driver = create_driver(options)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    return driver


def linkedin_login(driver):
    driver.get("https://www.linkedin.com/login")
    print("\n" + "="*60)
    print("🤖 [ACTION REQUIRED]")
    print("Login to LinkedIn in the Chrome window.")
    input("👉 Press ENTER when fully logged in... ")
    print("="*60 + "\n")
    return True


def search_jobs(driver, keyword):
    log.info(f"🔍 LinkedIn search: '{keyword}'")
    url = (
        f"https://www.linkedin.com/jobs/search/?"
        f"keywords={keyword.replace(' ', '%20')}"
        f"&location={config.SEARCH['location'].replace(' ', '%20')}"
        f"&f_AL=true&f_TPR=r604800&sortBy=DD"
    )
    if config.SEARCH.get("remote_only"):
        url += "&f_WT=2"

    exp_map = {"Entry Level": "1", "Associate": "2", "Mid-Senior Level": "3", "Director": "4"}
    codes   = [exp_map[e] for e in config.SEARCH.get("experience_level", []) if e in exp_map]
    if codes:
        url += "&f_E=" + "%2C".join(codes)

    driver.get(url)
    sleep(3, 5)


def get_job_cards(driver):
    try:
        return WebDriverWait(driver, 10).until(
            EC.presence_of_all_elements_located(
                (By.CSS_SELECTOR, ".job-card-container, .jobs-search-results__list-item")
            )
        )
    except TimeoutException:
        return []


# ── Smart Answer Engine (original + AI fallback) ──────────────

def find_answer(question_text: str) -> str:
    q = question_text.lower().strip()
    for keyword, answer in config.SAVED_ANSWERS.items():
        if keyword.lower() in q:
            return str(answer)
    if any(w in q for w in ["year", "experience", "how long", "how many"]):
        return config.EXPERIENCE.get("total_years", "4")
    if any(w in q for w in ["salary", "ctc", "compensation", "pay"]):
        return config.EXPERIENCE.get("expected_salary", "2500000")
    if any(w in q for w in ["notice", "join", "start", "available"]):
        return config.WORK_AUTH.get("notice_period", "30 days")
    if any(w in q for w in ["yes", "no", "are you", "do you", "have you", "can you"]):
        return "Yes"
    # AI fallback
    log.info(f"  → AI answering: {question_text[:60]}...")
    return ai_engine.answer_question(question_text)


def fill_field(field, answer):
    tag        = field.tag_name.lower()
    field_type = field.get_attribute("type") or ""
    try:
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
                    field.find_element(By.XPATH, "./following-sibling::label").click()
                except Exception:
                    field.click()
        elif tag in ["input", "textarea"]:
            if field_type not in ["file", "submit", "button"]:
                field.clear()
                human_type(field, answer)
    except (ElementNotInteractableException, StaleElementReferenceException):
        pass


def handle_easy_apply_modal(driver, job_title: str, company: str) -> bool:
    wait     = WebDriverWait(driver, 10)
    max_steps = 10
    step      = 0

    # Generate AI cover letter once for this job
    cover_letter = ai_engine.generate_cover_letter(job_title, company, "")

    while step < max_steps:
        step += 1
        sleep(1.5, 3)

        # Resume upload
        try:
            upload      = driver.find_element(By.CSS_SELECTOR, "input[type='file']")
            resume_path = Path(config.PERSONAL["resume_path"]).resolve()
            if resume_path.exists():
                upload.send_keys(str(resume_path))
                sleep(2)
        except NoSuchElementException:
            pass

        # Fill form fields
        try:
            questions = driver.find_elements(
                By.CSS_SELECTOR,
                ".jobs-easy-apply-form-section__grouping, "
                ".fb-form-element, "
                ".jobs-easy-apply-form-element"
            )
            for q_block in questions:
                try:
                    label_el = None
                    for sel in ["label", ".fb-dash-form-element__label", ".t-bold", "span"]:
                        try:
                            label_el = q_block.find_element(By.CSS_SELECTOR, sel)
                            break
                        except Exception:
                            pass

                    q_text = label_el.text if label_el else ""

                    # Inject AI cover letter if it's a cover letter textarea
                    if any(kw in q_text.lower() for kw in ["cover letter", "motivation", "why do you"]):
                        answer = cover_letter
                    else:
                        answer = find_answer(q_text)

                    for field in q_block.find_elements(By.CSS_SELECTOR, "input, select, textarea"):
                        fill_field(field, answer)
                        sleep(0.2, 0.5)
                except StaleElementReferenceException:
                    pass
        except Exception as e:
            log.debug(f"Form fill: {e}")

        # Submit
        try:
            driver.find_element(By.CSS_SELECTOR, "button[aria-label='Submit application']").click()
            sleep(2, 3)
            log.info(f"  ✅ Applied: {job_title}")
            return True
        except NoSuchElementException:
            pass

        # Next / Review
        try:
            driver.find_element(
                By.CSS_SELECTOR,
                "button[aria-label='Continue to next step'], "
                "button[aria-label='Review your application']"
            ).click()
            sleep(1.5, 2.5)
            continue
        except NoSuchElementException:
            pass

        try:
            driver.find_element(By.XPATH, "//button[contains(.,'Review') or contains(.,'Submit')]").click()
            sleep(1.5, 2.5)
            continue
        except NoSuchElementException:
            pass

        # Dismiss / give up
        try:
            driver.find_element(By.CSS_SELECTOR, "button[aria-label='Dismiss'], button[aria-label='Cancel']").click()
        except NoSuchElementException:
            pass
        return False

    return False


def apply_to_job(driver, job_card, applied_titles: set) -> bool:
    try:
        job_card.click()
        sleep(2, 3)
        wait = WebDriverWait(driver, 10)

        try:
            title_el  = wait.until(EC.presence_of_element_located(
                (By.CSS_SELECTOR, ".job-details-jobs-unified-top-card__job-title, h1")
            ))
            job_title = title_el.text.strip()
        except Exception:
            job_title = "Unknown Role"

        try:
            co_el   = driver.find_element(By.CSS_SELECTOR, ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name")
            company = co_el.text.strip()
        except Exception:
            company = "Unknown Company"

        full_title = f"{job_title} @ {company}"
        if full_title in applied_titles:
            return False

        # ── AI scoring ───────────────────────────────────────
        try:
            jd_el   = driver.find_element(By.CSS_SELECTOR, ".job-details-about-the-job-module, .jobs-description")
            jd_text = jd_el.text[:1000]
        except Exception:
            jd_text = job_title

        min_score = config.AI.get("min_match_score", 0)
        if config.AI.get("enabled", True) and min_score > 0:
            result = ai_engine.score_job(job_title, jd_text)
            score  = result.get("score", -1)
            if score == -1:
                log.warning(f"  AI scoring failed for '{job_title}' — skipping to be safe")
                return False
            if score < min_score:
                log.info(f"  ✗ Skipped [{score}%]: {full_title}")
                sheets_logger.log_application(
                    platform="LinkedIn", job_title=job_title, company=company,
                    status="Skipped (score)", match_score=score
                )
                return False
            log.info(f"📋 Applying [{score}%]: {full_title}")
        else:
            score = 0
            log.info(f"📋 Applying: {full_title}")

        # ── Easy Apply button ─────────────────────────────────
        try:
            apply_btn = wait.until(EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "button.jobs-apply-button[aria-label*='Easy Apply'], .jobs-s-apply button")
            ))
            if "Easy Apply" not in apply_btn.text:
                return False
            apply_btn.click()
            sleep(2, 3)
        except TimeoutException:
            return False

        # ── Handle modal ──────────────────────────────────────
        success = handle_easy_apply_modal(driver, job_title, company)
        if success:
            applied_titles.add(full_title)
            sheets_logger.log_application(
                platform="LinkedIn", job_title=job_title, company=company,
                status="Applied", match_score=score, cover_letter_used=True
            )
        return success

    except Exception as e:
        log.error(f"LinkedIn apply error: {e}")
        return False


def save_log(applied_titles):
    path = f"applied_jobs_{datetime.now().strftime('%Y%m%d')}.txt"
    with open(path, "w") as f:
        f.write(f"Applied — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n{'='*60}\n")
        for t in sorted(applied_titles):
            f.write(f"✅ {t}\n")
    log.info(f"📊 Log: {path} ({len(applied_titles)} applied)")


def run_linkedin_bot():
    log.info("─── LINKEDIN BOT STARTED ───")
    driver         = None
    applied_titles = set()
    total_applied  = 0
    max_apps       = config.SEARCH["max_applications"]

    try:
        driver = get_driver()
        linkedin_login(driver)

        for keyword in config.SEARCH["keywords"]:
            if total_applied >= max_apps:
                break
            search_jobs(driver, keyword)
            page = 1

            while total_applied < max_apps:
                log.info(f"  Page {page} — '{keyword}'")
                for _ in range(5):
                    driver.execute_script("document.querySelector('.jobs-search-results-list')?.scrollBy(0, 500)")
                    sleep(0.5, 1)

                cards = get_job_cards(driver)
                log.info(f"  {len(cards)} cards")
                if not cards:
                    break

                for card in cards:
                    if total_applied >= max_apps:
                        break
                    try:
                        if apply_to_job(driver, card, applied_titles):
                            total_applied += 1
                        sleep(2, 5)
                    except Exception as e:
                        log.error(f"Card error: {e}")

                max_pages = config.SEARCH.get("max_pages", 20)
                if page >= max_pages:
                    break
                try:
                    driver.find_element(By.CSS_SELECTOR, "button[aria-label='View next page']").click()
                    sleep(3, 5)
                    page += 1
                except Exception:
                    break
            sleep(5, 10)

    except KeyboardInterrupt:
        log.info("⛔ Stopped manually.")
    finally:
        save_log(applied_titles)
        log.info(f"─── LinkedIn done: {total_applied} applied ───")
        if driver is not None:
            driver.quit()


if __name__ == "__main__":
    run_linkedin_bot()
