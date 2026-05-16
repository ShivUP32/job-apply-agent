// Naukri job application automation
// Injected by background.js when the Naukri jobs tab finishes loading.
// Uses collect/apply mode so background.js handles tab navigation (content scripts
// don't survive window.location.href reassignment).

(async function () {
  const { sleep, waitFor, fillInput, log, isRunning } = window.__AP__;
  const scoreJob = window.__AP__.scoreJob.bind(window.__AP__);
  const PLATFORM = "naukri";

  async function getProfile() {
    const { profile } = await new Promise(r => chrome.storage.local.get("profile", r));
    return profile;
  }

  // ── Fill Naukri's quick-apply form ────────────────────────────────────────

  async function fillQuickApply(profile) {
    const form = document.querySelector(".apply-button-container, #quickApply, .quick-apply-container");
    if (!form) return;

    const fields = {
      "input[name*=phone], input[id*=phone]":  profile.phone,
      "input[name*=city], input[id*=city]":    profile.city,
      "input[name*=notice], input[id*=notice]": profile.notice_period,
    };
    for (const [sel, val] of Object.entries(fields)) {
      const el = form.querySelector(sel);
      if (el && !el.value && val) fillInput(el, val);
    }
  }

  // ── Apply to the job on the current page ─────────────────────────────────

  async function applyToCurrentJob(profile) {
    await sleep(2500);

    const titleEl   = document.querySelector("h1.jd-header-title, .job-tittle h1");
    const companyEl = document.querySelector(".jd-header-comp-name a, .comp-info-name a");
    const descEl    = document.querySelector(".job-desc, #job-desc, .dang-inner-html");

    const title       = titleEl?.textContent?.trim()   || document.title;
    const company     = companyEl?.textContent?.trim() || "";
    const description = descEl?.textContent?.trim()    || "";

    log(`Checking: ${title} @ ${company}`);
    const score = await scoreJob(title, description, profile);
    log(`  Match: ${score}%${score < (profile.min_match_score || 70) ? " — skip" : ""}`);

    if (score < (profile.min_match_score || 70)) {
      chrome.runtime.sendMessage({ type: "NAUKRI_NEXT", applied: false });
      return;
    }

    const alreadyApplied = document.querySelector(".already-applied, [class*='alreadyApplied']");
    if (alreadyApplied) {
      log("  ✗ Already applied");
      chrome.runtime.sendMessage({ type: "NAUKRI_NEXT", applied: false });
      return;
    }

    const applyBtn = document.querySelector(
      "button#apply-button, .apply-button button, a.apply-button, [data-ga-track*='Apply']:not([data-ga-track*='SaveJob'])"
    );
    if (!applyBtn) {
      log("  ✗ No Apply button found");
      chrome.runtime.sendMessage({ type: "NAUKRI_NEXT", applied: false });
      return;
    }

    applyBtn.click();
    await sleep(2000);

    await fillQuickApply(profile);
    await sleep(500);

    const submitBtn = document.querySelector(
      ".apply-button-container button[type=submit], #quickApply button[type=submit]"
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(2000);
    }

    const success = document.querySelector(
      ".success-container, .applied-tag, [class*='successMsg'], [class*='applied']"
    );
    const applied = !!success;

    if (applied) {
      log(`  ✅ Applied to ${title} @ ${company}`);
      chrome.runtime.sendMessage({ type: "JOB_APPLIED", job: `${title} @ ${company}` });
    }

    chrome.runtime.sendMessage({ type: "NAUKRI_NEXT", applied });
  }

  // ── Main: collect mode or apply mode ─────────────────────────────────────

  async function run() {
    const profile = await getProfile();
    if (!profile) {
      log("✗ No profile found. Save your profile on the ApplyPilot site first.");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    // Check if we're in apply mode (background already navigated us to a job page)
    const { naukriUrls } = await new Promise(r => chrome.storage.local.get("naukriUrls", r));

    if (naukriUrls) {
      // APPLY MODE: background navigated us here — apply and signal next
      await applyToCurrentJob(profile);
      return;
    }

    // COLLECT MODE: we're on the search results page — gather job links
    log(`Naukri: searching for "${profile.target_roles?.[0] || "jobs"}"…`);

    try {
      await waitFor(".jobTuple, .job-tuple, article.jobTupleHeader, .srp-jobtuple-wrapper", document, 15000);
    } catch {
      log("⚠ Naukri: No jobs loaded. Are you logged in to Naukri?");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    await sleep(1500);

    const maxApps = profile.max_applications || 20;
    const links = Array.from(document.querySelectorAll(
      ".jobTuple a.title, .job-tuple a.title, article.jobTupleHeader a, .srp-jobtuple-wrapper a.title"
    )).map(a => a.href).filter(Boolean).slice(0, maxApps * 2);

    if (!links.length) {
      log("⚠ Naukri: No job links found on results page.");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    log(`Naukri: found ${links.length} jobs to check`);

    // Store URLs and kick off background-driven navigation
    await chrome.storage.local.set({ naukriUrls: links, naukriIndex: 0, naukriApplied: 0 });
    chrome.runtime.sendMessage({ type: "NAUKRI_NEXT", applied: false });
  }

  run();
})();
