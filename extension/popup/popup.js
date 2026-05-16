const dot        = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const platformText = document.getElementById("platformText");
const stat       = document.getElementById("stat");
const stopBtn    = document.getElementById("stopBtn");

function refresh() {
  chrome.storage.local.get(["running", "currentPlatform", "stats"], (data) => {
    if (data.running) {
      dot.className = "dot running";
      statusText.textContent = "Running…";
      platformText.textContent = data.currentPlatform ? `Platform: ${data.currentPlatform}` : "";
      stopBtn.style.display = "block";
    } else {
      dot.className = "dot";
      statusText.textContent = "Idle";
      platformText.textContent = "";
      stopBtn.style.display = "none";
    }
    const s = data.stats;
    stat.textContent = s?.applied_today ? `Applied to ${s.applied_today} jobs today` : "";
  });
}

document.getElementById("openBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://job-hunt-agent-iota.vercel.app" });
  window.close();
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP" }, () => setTimeout(refresh, 300));
});

refresh();
setInterval(refresh, 2000);
