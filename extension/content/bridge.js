// bridge.js — runs on the Vercel page
// Bridges window.postMessage ↔ chrome.runtime so the React app can talk to the extension.

const PAGE_ORIGIN = window.location.origin;

// Flag the extension as present (checked synchronously by React on init)
window.__APPLYPILOT_INSTALLED = true;

// Also send a message so React can detect it asynchronously
window.postMessage({ type: "APPLYPILOT_READY" }, PAGE_ORIGIN);

// ── Page → Extension ─────────────────────────────────────────────────────────

window.addEventListener("message", (e) => {
  // Only accept messages from the same page origin — blocks iframe/ad injection
  if (e.origin !== PAGE_ORIGIN) return;
  if (e.source !== window || typeof e.data?.type !== "string") return;
  if (!e.data.type.startsWith("APPLYPILOT_")) return;

  const msg = e.data;

  if (msg.type === "APPLYPILOT_SAVE_PROFILE") {
    chrome.runtime.sendMessage({ type: "SAVE_PROFILE", profile: msg.profile }, (r) => {
      window.postMessage({ type: "APPLYPILOT_SAVED", ok: !!r?.ok }, PAGE_ORIGIN);
    });
  }

  if (msg.type === "APPLYPILOT_RUN") {
    chrome.runtime.sendMessage({ type: "RUN", platforms: msg.platforms, profile: msg.profile }, (r) => {
      window.postMessage({ type: "APPLYPILOT_RUN_ACK", ok: !!r?.ok }, PAGE_ORIGIN);
    });
  }

  if (msg.type === "APPLYPILOT_STOP") {
    chrome.runtime.sendMessage({ type: "STOP" }, (r) => {
      window.postMessage({ type: "APPLYPILOT_STOP_ACK", ok: !!r?.ok }, PAGE_ORIGIN);
    });
  }
});

// ── Extension → Page: poll storage every second ──────────────────────────────

const pollId = setInterval(() => {
  chrome.storage.local.get(["running", "logs", "stats", "currentPlatform"], (data) => {
    window.postMessage({ type: "APPLYPILOT_STATE", ...data }, PAGE_ORIGIN);
  });
}, 1000);

window.addEventListener("beforeunload", () => clearInterval(pollId));
