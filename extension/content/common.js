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

  // Groq-powered scorer (falls back to keyword if no key)
  async scoreJob(title, description, profile) {
    if (!profile.groq_api_key) return this.keywordScore(title, description, profile);
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + profile.groq_api_key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{
            role: "user",
            content:
              "Rate how well this job matches the candidate. Reply with ONLY a number 0-100, nothing else.\n\n" +
              "Job title: " + title + "\n" +
              "Job description (first 600 chars): " + description.slice(0, 600) + "\n\n" +
              "Candidate target roles: " + (profile.target_roles || []).join(", ") + "\n" +
              "Experience: " + profile.experience_years + " years\n" +
              "Resume summary: " + (profile.resume_text || "").slice(0, 400) + "\n\nScore:",
          }],
          max_tokens: 5,
          temperature: 0,
        }),
      });
      if (!res.ok) {
        this.log(`⚠ Groq API error ${res.status} — falling back to keyword scoring`);
        return this.keywordScore(title, description, profile);
      }
      const d = await res.json();
      const n = parseInt(d.choices?.[0]?.message?.content?.trim());
      return isNaN(n) ? this.keywordScore(title, description, profile) : n;
    } catch {
      return this.keywordScore(title, description, profile);
    }
  },
};
