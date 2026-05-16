// Indeed (India) job application automation

(async function () {
  const { sleep, waitFor, log, isRunning } = window.__AP__;
  const scoreJob = window.__AP__.scoreJob.bind(window.__AP__);
  const PLATFORM = "indeed";

  async function getProfile() {
    const { profile } = await new Promise(r => chrome.storage.local.get("profile", r));
    return profile;
  }

  async function run() {
    const profile = await getProfile();
    if (!profile) {
      log("✗ No profile found. Save your profile on the ApplyPilot site first.");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    const maxApps  = profile.max_applications || 20;
    const minScore = profile.min_match_score  || 70;
    let applied = 0;

    log(`Indeed: searching for "${profile.target_roles?.[0] || "jobs"}"…`);

    try {
      await waitFor(".jobsearch-ResultsList .resultContent, .job_seen_beacon", document, 15000);
    } catch {
      log("⚠ Indeed: No jobs loaded. Are you logged in to Indeed?");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    await sleep(1500);

    const cards = Array.from(document.querySelectorAll(".jobsearch-ResultsList li[class], .job_seen_beacon"));

    for (const card of cards) {
      if (!await isRunning(PLATFORM) || applied >= maxApps) break;

      card.click();
      await sleep(2500);

      const titleEl   = document.querySelector(".jobsearch-JobInfoHeader-title, h2.jobTitle");
      const companyEl = document.querySelector(".jobsearch-InlineCompanyRating-companyHeader a, [data-testid='inlineHeader-companyName']");
      const descEl    = document.querySelector("#jobDescriptionText");

      const title       = titleEl?.textContent?.trim()   || "Unknown";
      const company     = companyEl?.textContent?.trim() || "";
      const description = descEl?.textContent?.trim()    || "";

      log(`Checking: ${title} @ ${company}`);
      const score = await scoreJob(title, description, profile);
      log(`  Match: ${score}%${score < minScore ? " — skip" : ""}`);
      if (score < minScore) continue;

      // Look for Indeed Easy Apply (Instant Apply / Apply Now on-page form)
      const applyBtn = document.querySelector(
        "button[id*='indeedApplyButton'], .ia-IndeedApplyButton, button[aria-label*='Apply']"
      );
      if (!applyBtn) { log("  ✗ No Instant Apply button"); continue; }

      // Snapshot the apply button's state before clicking
      const applyBtnText = applyBtn.textContent?.trim();
      applyBtn.click();
      await sleep(3000);

      // Indeed's post-apply overlay lives inside a cross-origin iframe, so
      // document.querySelector can't reach it. Instead we detect success by:
      // 1. The apply button disappearing or changing label to "Applied"
      // 2. A "Applied" badge appearing in the job card detail panel
      const btnGone    = !document.querySelector("button[id*='indeedApplyButton'], .ia-IndeedApplyButton, button[aria-label*='Apply']");
      const appliedTag = document.querySelector("[class*='applied' i], [aria-label*='Applied' i], [data-testid*='applied' i]");
      const succeeded  = btnGone || !!appliedTag;

      if (succeeded) {
        applied++;
        log(`  ✅ Applied! (${applied}/${maxApps})`);
        chrome.runtime.sendMessage({ type: "JOB_APPLIED", job: `${title} @ ${company}` });
      } else {
        log(`  ✗ Apply button still present after click — may need manual steps (${applyBtnText})`);
      }

      await sleep(2000 + Math.random() * 1000);
    }

    log(`Indeed: done — applied to ${applied} job${applied !== 1 ? "s" : ""}`);
    chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: applied });
  }

  run();
})();
