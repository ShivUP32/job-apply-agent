// Naukri job application automation
// Injected by background.js when the Naukri jobs tab finishes loading.

(async function () {
  const { sleep, waitFor, fillInput, log, isRunning, scoreJob } = window.__AP__;
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
      "input[name*=phone], input[id*=phone]":   profile.phone,
      "input[name*=city],  input[id*=city]":    profile.city,
      "input[name*=notice],input[id*=notice]":  profile.notice_period,
    };
    for (const [sel, val] of Object.entries(fields)) {
      const el = form.querySelector(sel);
      if (el && !el.value && val) fillInput(el, val);
    }
  }

  // ── Process one job page ──────────────────────────────────────────────────

  async function applyToCurrentJob(profile) {
    // Wait for job detail to load
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

    if (score < (profile.min_match_score || 70)) return false;

    // Check if already applied
    const alreadyApplied = document.querySelector(".already-applied, [class*='alreadyApplied']");
    if (alreadyApplied) { log("  ✗ Already applied"); return false; }

    const applyBtn = document.querySelector(
      "button#apply-button, .apply-button button, a.apply-button, [data-ga-track*='Apply']:not([data-ga-track*='SaveJob'])"
    );
    if (!applyBtn) { log("  ✗ No Apply button found"); return false; }

    applyBtn.click();
    await sleep(2000);

    // Handle any quick-apply form that might appear
    await fillQuickApply(profile);
    await sleep(500);

    // Submit quick-apply form if visible
    const submitBtn = document.querySelector(
      ".apply-button-container button[type=submit], #quickApply button[type=submit]"
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(2000);
    }

    // Confirm success
    const success = document.querySelector(
      ".success-container, .applied-tag, [class*='successMsg'], [class*='applied']"
    );
    return !!success;
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

  async function run() {
    const profile = await getProfile();
    if (!profile) {
      log("✗ No profile found. Save your profile on the ApplyPilot site first.");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    const maxApps = profile.max_applications || 20;
    let applied = 0;

    log(`Naukri: searching for "${profile.target_roles?.[0] || "jobs"}"…`);

    try {
      await waitFor(".jobTuple, .job-tuple, article.jobTupleHeader, .srp-jobtuple-wrapper", document, 15000);
    } catch {
      log("⚠ Naukri: No jobs loaded. Are you logged in to Naukri?");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    await sleep(1500);

    // Collect job links from the listing page
    const links = Array.from(document.querySelectorAll(
      ".jobTuple a.title, .job-tuple a.title, article.jobTupleHeader a, .srp-jobtuple-wrapper a.title"
    )).map(a => a.href).filter(Boolean).slice(0, maxApps * 2);

    for (const url of links) {
      if (!await isRunning(PLATFORM) || applied >= maxApps) break;

      // Open job in same tab
      window.location.href = url;
      await sleep(4000);

      const ok = await applyToCurrentJob(profile);
      if (ok) {
        const title   = document.querySelector("h1.jd-header-title, .job-tittle h1")?.textContent?.trim() || "Job";
        const company = document.querySelector(".jd-header-comp-name a")?.textContent?.trim() || "";
        applied++;
        log(`  ✅ Applied! (${applied}/${maxApps})`);
        chrome.runtime.sendMessage({ type: "JOB_APPLIED", job: `${title} @ ${company}` });
      }

      // Go back to results
      window.history.back();
      await sleep(2500);
    }

    log(`Naukri: done — applied to ${applied} job${applied !== 1 ? "s" : ""}`);
    chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: applied });
  }

  run();
})();
