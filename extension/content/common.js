// common.js — injected before every job-site content script

window.__AP__ = {

  sleep: ms => new Promise(r => setTimeout(r, ms)),

  waitFor(selector, root, timeout) {
    root    = root    || document;
    timeout = timeout || 10000;
    return new Promise((resolve, reject) => {
      const found = root.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(root.nodeType === 1 ? root : document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error("Timeout: " + selector)); }, timeout);
    });
  },

  // React-compatible input setter
  fillInput(el, value) {
    const proto  = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  },

  log(msg) {
    chrome.runtime.sendMessage({ type: "LOG", msg });
  },

  getState() {
    return new Promise(r =>
      chrome.storage.local.get(["running", "currentPlatform", "profile"], r)
    );
  },

  async isRunning(platform) {
    const s = await this.getState();
    return s.running && s.currentPlatform === platform;
  },

  // Keyword fallback scorer
  keywordScore(title, description, profile) {
    const roles = (profile.target_roles || []).map(r => r.toLowerCase()).filter(Boolean);
    const t = title.toLowerCase();
    const d = description.toLowerCase();
    let score = 0;
    for (const r of roles) {
      if (t.includes(r)) score += 50;
      else if (d.includes(r)) score += 20;
    }
    return Math.min(100, score || 35);
  },

  // Groq-powered scorer — routes through background SW so the API key never
  // touches content scripts. Falls back to keyword scoring on any error.
  async scoreJob(title, description, profile) {
    try {
      const score = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: "SCORE_JOB",
            title,
            description,
            target_roles: profile.target_roles,
            experience_years: profile.experience_years,
            resume_text: profile.resume_text,
          },
          (r) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r?.score);
          }
        );
      });
      return typeof score === "number" ? score : this.keywordScore(title, description, profile);
    } catch {
      return this.keywordScore(title, description, profile);
    }
  },
};
