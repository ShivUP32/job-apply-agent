// LinkedIn Easy Apply automation
// Injected by background.js when the LinkedIn jobs tab finishes loading.

(async function () {
  const { sleep, waitFor, fillInput, log, isRunning, scoreJob } = window.__AP__;
  const PLATFORM = "linkedin";

  async function getProfile() {
    const { profile } = await new Promise(r => chrome.storage.local.get("profile", r));
    return profile;
  }

  // ── Fill one step of the Easy Apply form ──────────────────────────────────

  async function fillStep(profile) {
    const container = document.querySelector(".jobs-easy-apply-modal");
    if (!container) return;

    // Text / textarea inputs
    const inputs = container.querySelectorAll("input:not([type=file]):not([type=radio]):not([type=checkbox]), textarea");
    for (const input of inputs) {
      if (input.value && input.value.trim()) continue;
      const lbl = labelFor(input).toLowerCase();
      const val = matchValue(lbl, profile);
      if (val) fillInput(input, val);
    }

    // <select> elements
    const selects = container.querySelectorAll("select");
    for (const sel of selects) {
      if (sel.value && sel.selectedIndex > 0) continue;
      const lbl = labelFor(sel).toLowerCase();
      const opts = Array.from(sel.options).map(o => o.text.toLowerCase());
      let pick = -1;
      if (/authorized|eligible|legally|work in/.test(lbl)) pick = opts.findIndex(o => o === "yes");
      else if (/sponsor/.test(lbl))                         pick = opts.findIndex(o => o === "no");
      else if (/notice/.test(lbl)) {
        pick = opts.findIndex(o => o.includes((profile.notice_period || "").toLowerCase()));
      }
      if (pick >= 0) {
        sel.selectedIndex = pick;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // Radio buttons
    const groups = container.querySelectorAll("fieldset, .fb-dash-form-element");
    for (const group of groups) {
      const lbl = (group.querySelector("legend, label")?.textContent || "").toLowerCase();
      const radios = group.querySelectorAll("input[type=radio]");
      if (!radios.length) continue;
      if (/authorized|eligible|legally|remote|relocate/.test(lbl)) clickRadio(radios, "yes");
      else if (/sponsor|disability|veteran/.test(lbl))              clickRadio(radios, "no");
    }

    await sleep(400);
  }

  function labelFor(el) {
    const id  = el.id;
    const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
    if (lbl) return lbl.textContent;
    return el.closest(".fb-dash-form-element, .jobs-easy-apply-form-section__grouping")
             ?.querySelector("label, legend")?.textContent || el.getAttribute("aria-label") || "";
  }

  function matchValue(lbl, profile) {
    if (/phone|mobile/.test(lbl))                            return profile.phone;
    if (/city|location/.test(lbl))                          return profile.city;
    if (/linkedin/.test(lbl))                               return profile.linkedin_url;
    if (/github/.test(lbl))                                 return profile.github_url;
    if (/portfolio|website/.test(lbl))                      return profile.portfolio_url;
    if (/current.*(salary|ctc)/.test(lbl))                 return profile.current_ctc;
    if (/expect.*(salary|ctc)/.test(lbl))                  return profile.expected_ctc;
    if (/notice/.test(lbl))                                 return profile.notice_period;
    if (/year.*exp|experience.*year/.test(lbl))             return String(profile.experience_years);
    if (/first.*name/.test(lbl))                            return profile.first_name;
    if (/last.*name/.test(lbl))                             return profile.last_name;
    if (/email/.test(lbl))                                  return profile.email;
    return null;
  }

  function clickRadio(radios, answer) {
    const target = Array.from(radios).find(r => {
      const text = (r.closest("label")?.textContent || r.value || "").toLowerCase();
      return text.includes(answer);
    });
    if (target && !target.checked) target.click();
  }

  // ── Navigate through multi-step Easy Apply modal ──────────────────────────

  async function handleEasyApply(profile) {
    for (let step = 0; step < 20; step++) {
      if (!await isRunning(PLATFORM)) return false;
      await sleep(1200);

      const modal = document.querySelector(".jobs-easy-apply-modal");
      if (!modal) return false;

      await fillStep(profile);
      await sleep(600);

      // Submit
      const submitBtn = modal.querySelector(
        "button[aria-label='Submit application'], footer button[aria-label*='Submit']"
      );
      if (submitBtn && !submitBtn.disabled) {
        submitBtn.click();
        await sleep(3000);
        return true;
      }

      // Review step
      const reviewBtn = modal.querySelector("button[aria-label='Review your application']");
      if (reviewBtn && !reviewBtn.disabled) {
        reviewBtn.click();
        await sleep(1500);
        continue;
      }

      // Next step
      const nextBtn = modal.querySelector(
        "button[aria-label='Continue to next step'], footer button[aria-label*='Next'], footer button[aria-label*='Continue']"
      );
      if (nextBtn && !nextBtn.disabled) {
        nextBtn.click();
        await sleep(1500);
      } else {
        break;
      }
    }

    // Dismiss if we couldn't complete
    const dismiss = document.querySelector("[aria-label='Dismiss'], .artdeco-modal__dismiss");
    if (dismiss) {
      dismiss.click();
      await sleep(800);
      const discard = document.querySelector("button[data-test-dialog-secondary-btn]");
      if (discard) discard.click();
    }
    return false;
  }

  // ── Main loop ─────────────────────────────────────────────────────────────

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
    let page    = 1;

    log(`LinkedIn: searching for "${profile.target_roles?.[0] || "jobs"}"…`);

    try {
      await waitFor(".jobs-search-results__list-item, .job-card-container", document, 15000);
    } catch {
      log("⚠ LinkedIn: No jobs loaded. Are you logged in to LinkedIn?");
      chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: 0 });
      return;
    }

    while (applied < maxApps && await isRunning(PLATFORM)) {
      await sleep(2000);

      const cards = Array.from(
        document.querySelectorAll(".jobs-search-results__list-item:not([data-ap-visited])")
      );

      if (!cards.length) break;

      for (const card of cards) {
        if (!await isRunning(PLATFORM) || applied >= maxApps) break;
        card.dataset.apVisited = "1";

        // Skip already-applied cards
        if (card.querySelector("[aria-label*='Applied']") ||
            card.textContent.includes("Applied")) continue;

        card.click();
        await sleep(2500);

        const titleEl   = document.querySelector(
          ".job-details-jobs-unified-top-card__job-title h1, h2.t-24.t-bold.t-black"
        );
        const companyEl = document.querySelector(
          ".job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name"
        );
        const descEl    = document.querySelector(
          "#job-details .jobs-description-content__text, .jobs-description__content"
        );

        const title       = titleEl?.textContent?.trim()   || "Unknown Role";
        const company     = companyEl?.textContent?.trim() || "Unknown Company";
        const description = descEl?.textContent?.trim()    || "";

        log(`Checking: ${title} @ ${company}`);

        const score = await scoreJob(title, description, profile);
        log(`  Match: ${score}%${score < minScore ? " — skip" : ""}`);
        if (score < minScore) continue;

        const easyApplyBtn = document.querySelector(
          ".jobs-apply-button button[aria-label*='Easy Apply'], .jobs-s-apply button[aria-label*='Easy Apply']"
        );
        if (!easyApplyBtn) { log("  ✗ No Easy Apply button"); continue; }

        easyApplyBtn.click();
        await sleep(2000);

        if (!document.querySelector(".jobs-easy-apply-modal")) {
          log("  ✗ Easy Apply modal did not open");
          continue;
        }

        const ok = await handleEasyApply(profile);
        if (ok) {
          applied++;
          log(`  ✅ Applied! (${applied}/${maxApps})`);
          chrome.runtime.sendMessage({ type: "JOB_APPLIED", job: `${title} @ ${company}` });
        } else {
          log("  ✗ Could not complete application");
        }

        await sleep(2000 + Math.random() * 2000);
      }

      // Next page
      const nextPage = document.querySelector(`button[aria-label="Page ${page + 1}"]`);
      if (!nextPage || applied >= maxApps) break;
      nextPage.click();
      page++;
      await sleep(3000);
    }

    log(`LinkedIn: done — applied to ${applied} job${applied !== 1 ? "s" : ""}`);
    chrome.runtime.sendMessage({ type: "PLATFORM_DONE", platform: PLATFORM, count: applied });
  }

  run();
})();
