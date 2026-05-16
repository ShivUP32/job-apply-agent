"""
driver_utils.py — shared ChromeDriver setup for all ApplyPilot bots.

macOS: removes the Gatekeeper quarantine flag (com.apple.quarantine) that
       causes ChromeDriver to be killed with status -9 on Apple Silicon / macOS 13+.
Windows: removes the Zone.Identifier alternate data stream (Mark of the Web)
         that causes SmartScreen / Defender to block the downloaded binary.

SessionNotCreatedException (version mismatch): clears the WDM cache and
       re-downloads the correct ChromeDriver for the installed Chrome version.
"""

import logging
import os
import platform
import shutil
import subprocess

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import SessionNotCreatedException
from webdriver_manager.chrome import ChromeDriverManager

log = logging.getLogger(__name__)

# Flags that prevent Chrome from crashing in restricted / container environments
_STABILITY_FLAGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
]


def _unblock_macos(driver_path: str) -> None:
    """Strip the macOS Gatekeeper quarantine xattr."""
    try:
        subprocess.run(
            ["xattr", "-d", "com.apple.quarantine", driver_path],
            capture_output=True,
        )
    except Exception:
        pass  # xattr not present or flag already absent — safe to ignore


def _unblock_windows(driver_path: str) -> None:
    """Remove the Zone.Identifier ADS (Mark of the Web) that Windows adds to downloaded files."""
    # Method 1: delete the alternate data stream directly
    zone_path = driver_path + ":Zone.Identifier"
    try:
        if os.path.exists(zone_path):
            os.remove(zone_path)
            return
    except Exception:
        pass

    # Method 2: PowerShell Unblock-File as fallback
    try:
        subprocess.run(
            ["powershell", "-Command", f"Unblock-File -Path '{driver_path}'"],
            capture_output=True,
        )
    except Exception:
        pass


def _install_and_unblock() -> str:
    """Download ChromeDriver, unblock it on macOS/Windows, and return its path."""
    driver_path = ChromeDriverManager().install()

    system = platform.system()
    if system == "Darwin":
        _unblock_macos(driver_path)
    elif system == "Windows":
        _unblock_windows(driver_path)

    return driver_path


def _clear_wdm_cache() -> None:
    """Delete the local WDM cache so the next install fetches a fresh binary."""
    cache_dir = os.path.join(os.path.expanduser("~"), ".wdm")
    if os.path.isdir(cache_dir):
        try:
            shutil.rmtree(cache_dir)
            log.info("Cleared WDM cache — will re-download ChromeDriver.")
        except Exception as e:
            log.warning(f"Could not clear WDM cache: {e}")


def _add_stability_flags(options: Options) -> None:
    """Add crash-prevention flags to a Chrome Options object (idempotent)."""
    existing = options.arguments
    for flag in _STABILITY_FLAGS:
        if flag not in existing:
            options.add_argument(flag)


def create_driver(options: Options) -> webdriver.Chrome:
    """
    Create a Chrome WebDriver with automatic recovery from version mismatches.

    On SessionNotCreatedException (Chrome/ChromeDriver version mismatch):
      1. Clears the WDM cache.
      2. Re-downloads the ChromeDriver that matches the installed Chrome.
      3. Retries once.

    Stability flags (--no-sandbox, --disable-dev-shm-usage, etc.) are added
    automatically so the caller does not need to include them.
    """
    _add_stability_flags(options)

    # First attempt with whatever ChromeDriver WDM has cached
    try:
        driver_path = _install_and_unblock()
        service = Service(driver_path)
        driver = webdriver.Chrome(service=service, options=options)
        return driver
    except SessionNotCreatedException as exc:
        log.warning(
            f"ChromeDriver version mismatch ({exc.msg[:120] if exc.msg else exc}). "
            "Clearing cache and retrying..."
        )

    # Clear stale cache and retry with a fresh download
    _clear_wdm_cache()
    try:
        driver_path = _install_and_unblock()
        service = Service(driver_path)
        driver = webdriver.Chrome(service=service, options=options)
        log.info("ChromeDriver re-downloaded and session created successfully.")
        return driver
    except SessionNotCreatedException as exc:
        log.error(
            "ChromeDriver still cannot start Chrome after re-download. "
            "Make sure Google Chrome is installed and up to date. "
            f"Details: {exc}"
        )
        raise


# kept for backwards-compat; prefer create_driver()
def get_chromedriver_service() -> Service:
    """Install ChromeDriver and unblock it on macOS and Windows."""
    return Service(_install_and_unblock())
