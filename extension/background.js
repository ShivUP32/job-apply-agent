// background.js — Manifest V3 service worker
// All mutable state lives in chrome.storage.local so it survives SW restarts.

// ── Helpers ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString("en-IN", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

async function addLog(msg) {
  const { logs = [] } = await chrome.storage.local.get("logs");
  logs.push({ time: ts(), msg });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await chrome.storage.local.set({ logs });
}

async function get(keys) {
  return chrome.storage.local.get(keys);
}

// ── Build search URL per platform ────────────────────────────────────────────

function platformUrl(platform, profile) {
  const kw  = encodeURIComponent(profile?.target_roles?.[0] || "Software Engineer");
  const loc = encodeURIComponent(
    profile?.target_location === "Remote" ? "India" : (profile?.city || "India")
  );
  switch (platform) {
    case "linkedin":
      return `https://www.linkedin.com/jobs/search/?keywords=${kw}&location=${loc}&f_AL=true&sortBy=R`;
    case "naukri":
      return `https://www.naukri.com/jobs-in-india?k=${kw}&l=${loc}`;
    case "indeed":
      return `https://in.indeed.com/jobs?q=${kw}&l=${loc}`;
    case "glassdoor":
      return `https://www.glassdoor.co.in/Job/jobs.htm?sc.keyword=${kw}`;
    case "foundit":
      return `https://www.foundit.in/srp/results?query=${kw}&locations=${loc}`;
    default:
      return null;
  }
}

// ── Open next platform ───────────────────────────────────────────────────────

async function openNextPlatform() {
  const { platforms = [], platformIndex = 0, profile, running } =
    await get(["platforms", "platformIndex", "profile", "running"]);

  if (!running) return;

  if (platformIndex >= platforms.length) {
    await chrome.storage.local.set({ running: false, currentPlatform: null });
    await addLog("✅ All platforms done. Check the Tracker tab for results.");
    return;
  }

  const platform = platforms[platformIndex];
  const url = platformUrl(platform, profile);

  if (!url) {
    await chrome.storage.local.set({ platformIndex: platformIndex + 1 });
    return openNextPlatform();
  }

  await chrome.storage.local.set({ currentPlatform: platform });
  await addLog(`▶ Starting ${platform}…`);

  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.local.set({ activeTabId: tab.id });
}

// ── Inject content scripts when job-site tab finishes loading ────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;

  const { running, activeTabId, currentPlatform } =
    await get(["running", "activeTabId", "currentPlatform"]);

  if (!running || tabId !== activeTabId || !currentPlatform) return;

  const supported = ["linkedin", "naukri", "indeed", "glassdoor", "foundit"];
  if (!supported.includes(currentPlatform)) return;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/common.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [`content/${currentPlatform}.js`] });
  } catch (e) {
    await addLog(`⚠ Could not inject script for ${currentPlatform}: ${e.message}`);
  }
});

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true; // async response
});

async function handle(msg) {
  switch (msg.type) {

    case "SAVE_PROFILE":
      await chrome.storage.local.set({ profile: msg.profile });
      return { ok: true };

    case "RUN": {
      await chrome.storage.local.set({
        running: true,
        platforms: msg.platforms,
        platformIndex: 0,
        logs: [],
        stats: { applied_today: 0, applied_jobs: [] },
        ...(msg.profile ? { profile: msg.profile } : {}),
      });
      await addLog(`▶ ApplyPilot starting — ${msg.platforms.join(", ")}`);
      await openNextPlatform();
      return { ok: true };
    }

    case "STOP": {
      const { activeTabId } = await get("activeTabId");
      if (activeTabId) { try { await chrome.tabs.remove(activeTabId); } catch {} }
      await chrome.storage.local.set({ running: false, currentPlatform: null, activeTabId: null });
      await addLog("⛔ Stopped by user");
      return { ok: true };
    }

    case "LOG":
      await addLog(msg.msg);
      return { ok: true };

    case "PLATFORM_DONE": {
      await addLog(`✓ ${msg.platform} done — applied to ${msg.count} job${msg.count !== 1 ? "s" : ""}`);
      const { activeTabId, platformIndex = 0 } = await get(["activeTabId", "platformIndex"]);
      if (activeTabId) { try { await chrome.tabs.remove(activeTabId); } catch {} }
      await chrome.storage.local.set({ platformIndex: platformIndex + 1, activeTabId: null });
      await openNextPlatform();
      return { ok: true };
    }

    case "JOB_APPLIED": {
      const { stats = { applied_today: 0, applied_jobs: [] } } = await get("stats");
      stats.applied_today++;
      stats.applied_jobs.push(msg.job);
      if (stats.applied_jobs.length > 100) stats.applied_jobs.splice(0, stats.applied_jobs.length - 100);
      await chrome.storage.local.set({ stats });
      return { ok: true };
    }

    default:
      return { ok: false, error: "unknown message type" };
  }
}
