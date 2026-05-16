import { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const EXT_URL = "https://job-hunt-agent-iota.vercel.app"; // keep in sync with manifest host_permissions

const APPS_SCRIPT_CODE = `// SETUP — Script Properties (⚙ Project Settings → Script Properties):
//   WEBHOOK_SECRET  = <your long random secret>
//   TARGET_SHEET_ID = <spreadsheet ID from the sheet URL — the part between /d/ and /edit>

function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();

    // 1. Rate limit — max 1 write per 2 seconds
    var lastWrite = parseInt(props.getProperty('LAST_WRITE_TS') || '0');
    var now = Date.now();
    if (now - lastWrite < 2000) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Rate limited' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    props.setProperty('LAST_WRITE_TS', String(now));

    // 2. Authenticate
    var secret = props.getProperty('WEBHOOK_SECRET');
    var d = JSON.parse(e.postData.contents);
    if (!secret || d.secret !== secret) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. Open the sheet by its fixed ID (never accept sheet_url from the request)
    var sheetId = props.getProperty('TARGET_SHEET_ID');
    if (!sheetId) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'TARGET_SHEET_ID not configured' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheet = spreadsheet.getActiveSheet();

    // 4. Auto-populate headers if Row 1 is empty
    var firstRow = sheet.getRange(1, 1, 1, 8).getValues()[0];
    if (!firstRow.some(function(h) { return h !== ''; })) {
      sheet.getRange(1, 1, 1, 8).setValues([['Date', 'Company', 'Job Title', 'Platform', 'Job URL', 'Match %', 'Status', 'Notes']]);
    }

    // 5. Sanitize cell values to prevent formula injection (=, +, -, @)
    function safe(v) {
      var s = String(v == null ? '' : v);
      return /^[=+\\-@]/.test(s) ? "'" + s : s;
    }

    sheet.appendRow([
      safe(d.date), safe(d.company), safe(d.job_title), safe(d.platform),
      safe(d.job_url), Number(d.match_score) || 0, safe(d.status), safe(d.notes)
    ]);
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Internal error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput('ApplyPilot webhook live');
}`;


const PLATFORMS = [
  { id: "naukri",    label: "Naukri",    icon: "🇮🇳", desc: "India #1" },
  { id: "linkedin",  label: "LinkedIn",  icon: "💼", desc: "Easy Apply" },
  { id: "indeed",    label: "Indeed",    icon: "🔍", desc: "SmartApply" },
  { id: "glassdoor", label: "Glassdoor", icon: "🪟", desc: "With reviews" },
  { id: "foundit",   label: "Foundit",   icon: "🎯", desc: "ex-Monster" },
];

const SCHEDULES = [
  { id: "manual",     label: "Manual only",    desc: "You press Run" },
  { id: "daily_9am",  label: "Daily 9am",      desc: "Every morning" },
  { id: "twice_daily",label: "Twice daily",    desc: "9am + 6pm" },
  { id: "weekdays",   label: "Weekdays",       desc: "Mon–Fri 9am" },
];

function safeSheetUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "docs.google.com" ? url : null;
  } catch { return null; }
}

function App() {
  const [tab, setTab] = useState(() => window.__APPLYPILOT_INSTALLED ? "profile" : "setup");
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ applied_today: 0, applied_jobs: [] });
  const [extInstalled, setExtInstalled] = useState(() => !!window.__APPLYPILOT_INSTALLED);
  const [saving, setSaving] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState(["naukri", "linkedin"]);
  const [schedule, setSchedule] = useState("manual");
  const logsRef = useRef(null);

  const [profile, setProfile] = useState({
    first_name: "", last_name: "", email: "", phone: "",
    city: "Bangalore", linkedin_url: "",
    portfolio_url: "", github_url: "", other_url_1: "", other_url_2: "",
    resume_text: "",
    resume_pdf_name: "",
    target_roles: [""],
    target_location: "India",
    experience_years: 3,
    experience_months: 0,
    current_ctc: "", expected_ctc: "",
    notice_period: "30 days",
    min_match_score: 70,
    max_applications: 20,
    google_sheet_url: "",
  });

  // Listen for extension messages
  useEffect(() => {
    const handler = (e) => {
      // Only accept messages from the same page origin (blocks malicious iframes/ads)
      if (e.origin !== window.location.origin) return;
      if (!e.data?.type) return;
      if (e.data.type === "APPLYPILOT_READY") {
        setExtInstalled(true);
      }
      if (e.data.type === "APPLYPILOT_STATE") {
        setRunning(!!e.data.running);
        if (e.data.logs)  { setLogs(e.data.logs); }
        if (e.data.stats) { setStats(e.data.stats); }
        if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
      }
    };
    window.addEventListener("message", handler);
    // Re-check in case bridge.js already ran before this effect
    setTimeout(() => { if (window.__APPLYPILOT_INSTALLED) setExtInstalled(true); }, 200);
    return () => window.removeEventListener("message", handler);
  }, []);

  const p = (k, v) => setProfile(prev => ({ ...prev, [k]: v }));

  const addRole = () => p("target_roles", [...profile.target_roles, ""]);
  const updateRole = (i, v) => p("target_roles", profile.target_roles.map((r, idx) => idx === i ? v : r));
  const removeRole = i => p("target_roles", profile.target_roles.filter((_, idx) => idx !== i));

  const togglePlatform = id => setSelectedPlatforms(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);

  const handlePdfUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Store the file name immediately so the UI updates
    setProfile(prev => ({ ...prev, resume_pdf_name: file.name, resume_text: "Parsing PDF…" }));

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // Group items by vertical position to preserve line breaks
        const lines = {};
        content.items.forEach(item => {
          const y = Math.round(item.transform[5]);
          lines[y] = lines[y] ? lines[y] + " " + item.str : item.str;
        });
        const pageText = Object.keys(lines)
          .sort((a, b) => b - a)  // top-to-bottom
          .map(y => lines[y].trim())
          .filter(Boolean)
          .join("\n");
        pages.push(pageText);
      }
      const fullText = pages.join("\n\n").trim();
      setProfile(prev => ({ ...prev, resume_pdf_name: file.name, resume_text: fullText }));
    } catch (err) {
      setProfile(prev => ({ ...prev, resume_pdf_name: file.name, resume_text: "" }));
      alert("Could not parse PDF text — please paste your CV manually below.");
    }
  };

  const saveProfile = () => {
    if (!profile.first_name.trim() || !profile.email.trim()) {
      alert("First name and email are required before saving.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      alert("Please enter a valid email address.");
      return;
    }
    if (!profile.target_roles.some(r => r.trim())) {
      alert("Add at least one target job title before saving.");
      return;
    }
    if (!extInstalled) {
      alert("Please install the ApplyPilot browser extension first.");
      return;
    }
    setSaving(true);
    const payload = { ...profile, platforms: selectedPlatforms };
    // Cancel any previous pending ack listener before registering a new one
    if (window.__apAckRef) window.removeEventListener("message", window.__apAckRef);
    const ack = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "APPLYPILOT_SAVED") {
        window.removeEventListener("message", ack);
        window.__apAckRef = null;
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    };
    window.__apAckRef = ack;
    window.addEventListener("message", ack);
    window.postMessage({ type: "APPLYPILOT_SAVE_PROFILE", profile: payload }, window.location.origin);
    setTimeout(() => { window.removeEventListener("message", ack); window.__apAckRef = null; setSaving(false); }, 3000);
  };

  const startBot = () => {
    if (!extInstalled) { alert("Please install the ApplyPilot extension first."); return; }
    setTab("logs");
    setLogs([]);
    const payload = { ...profile, platforms: selectedPlatforms };
    // Wait for RUN_ACK before updating running state — avoids stuck UI if SW is dead
    const ack = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "APPLYPILOT_RUN_ACK") {
        window.removeEventListener("message", ack);
        if (e.data.ok) setRunning(true);
      }
    };
    window.addEventListener("message", ack);
    setTimeout(() => window.removeEventListener("message", ack), 4000);
    window.postMessage({ type: "APPLYPILOT_RUN", platforms: selectedPlatforms, profile: payload }, window.location.origin);
  };

  const stopBot = () => {
    window.postMessage({ type: "APPLYPILOT_STOP" }, window.location.origin);
    setRunning(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0b0d11", color: "#e2e6f0", fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Top nav */}
      <nav style={{ borderBottom: "1px solid #1e2330", padding: "0 2rem", display: "flex", alignItems: "center", gap: "2rem", height: 56 }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 15, color: "#fff", letterSpacing: "-.02em" }}>
          <span style={{ color: "#4ade80" }}>Apply</span>Pilot
        </div>
        <div style={{ display: "flex", gap: 4, flex: 1 }}>
          {[["setup", extInstalled ? "✓ Setup" : "⚡ Setup"], ["profile","Profile"],["platforms","Platforms"],["schedule","Schedule"],["logs","Logs"],["tracker","Tracker"]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              background: tab === id ? "#1a1f2e" : "none",
              border: tab === id ? "1px solid #2a3148" : "1px solid transparent",
              borderRadius: 6, padding: "5px 14px", color: tab === id ? "#fff" : "#7a849e",
              cursor: "pointer", fontSize: 13, fontFamily: "inherit",
            }}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: extInstalled ? "#4ade80" : "#f87171", boxShadow: extInstalled ? "0 0 8px #4ade8088" : "none" }} />
          <span style={{ fontSize: 12, color: extInstalled ? "#4ade80" : "#f87171" }}>
            {extInstalled ? "extension connected" : "extension not detected"}
          </span>
        </div>
        {running ? (
          <button onClick={stopBot} style={{ background: "#3f1515", border: "1px solid #f87171", color: "#f87171", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>⏹ Stop</button>
        ) : (
          <button onClick={startBot} disabled={!extInstalled} style={{ background: "#0f2e1a", border: "1px solid #4ade80", color: "#4ade80", borderRadius: 6, padding: "6px 16px", cursor: extInstalled ? "pointer" : "not-allowed", fontSize: 13, fontFamily: "inherit", opacity: extInstalled ? 1 : 0.4 }}>▶ Run now</button>
        )}
      </nav>

      {/* Extension offline banner (compact, shown on all tabs except setup) */}
      {!extInstalled && tab !== "setup" && (
        <div style={{ background: "#1a0f00", borderBottom: "1px solid #f59e0b40", padding: "10px 2rem", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "#fbbf24", flex: 1 }}>
            ⚡ Extension not installed — the bot can't run without it.
          </span>
          <button onClick={() => setTab("setup")} style={{ fontSize: 12, color: "#fbbf24", background: "none", border: "1px solid #f59e0b60", borderRadius: 5, padding: "4px 14px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            Setup guide →
          </button>
        </div>
      )}
      {/* Extension connected banner */}
      {extInstalled && (
        <div style={{ background: "#0d1a0d", borderBottom: "1px solid #4ade8030", padding: "8px 2rem", fontSize: 12, color: "#4ade80" }}>
          ✓ Extension connected — the bot will run directly in your browser using your existing login sessions.
        </div>
      )}

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>

        {/* ── SETUP TAB ── */}
        {tab === "setup" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: "0.4rem", color: "#fff" }}>Setup</h2>
            <p style={{ fontSize: 14, color: "#7a849e", marginBottom: "2rem" }}>
              ApplyPilot runs entirely in your own browser — no cloud server, no scripts to install. One-time setup takes about 2 minutes.
            </p>

            {extInstalled && (
              <div style={{ background: "#0d1a0d", border: "1px solid #4ade8060", borderRadius: 10, padding: "16px 20px", marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 22 }}>✅</div>
                <div>
                  <div style={{ fontWeight: 500, color: "#4ade80", marginBottom: 3 }}>Extension installed and connected</div>
                  <div style={{ fontSize: 13, color: "#7a849e" }}>You're all set. Fill your profile, pick platforms, and press Run now.</div>
                </div>
                <button onClick={() => setTab("profile")} style={{ marginLeft: "auto", background: "#4ade80", color: "#000", border: "none", borderRadius: 6, padding: "8px 20px", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "inherit", whiteSpace: "nowrap" }}>
                  Go to Profile →
                </button>
              </div>
            )}

            {/* Step 1 */}
            <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 12, padding: "20px 24px", marginBottom: "1rem" }}>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#4ade8022", border: "1.5px solid #4ade8060", display: "flex", alignItems: "center", justifyContent: "center", color: "#4ade80", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>1</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: "#fff", marginBottom: 6 }}>Download the extension</div>
                  <p style={{ fontSize: 13, color: "#7a849e", marginBottom: 14, lineHeight: 1.6 }}>
                    Download the ApplyPilot extension as a ZIP file. You'll load it into Chrome in the next step — no Chrome Web Store needed.
                  </p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <a
                      href="https://raw.githubusercontent.com/ShivUP32/job-apply-agent/main/extension.zip"
                      style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#4ade80", color: "#000", borderRadius: 7, padding: "9px 20px", fontWeight: 600, fontSize: 13, textDecoration: "none", fontFamily: "inherit" }}
                    >
                      ⬇ Download Extension
                    </a>
                    <a
                      href="https://github.com/ShivUP32/job-apply-agent/tree/main/extension"
                      target="_blank" rel="noopener noreferrer"
                      style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "none", color: "#7a849e", border: "1px solid #2a3148", borderRadius: 7, padding: "9px 18px", fontSize: 13, textDecoration: "none", fontFamily: "inherit" }}
                    >
                      View on GitHub ↗
                    </a>
                  </div>
                  <p style={{ fontSize: 12, color: "#3a4060", marginTop: 10 }}>
                    After downloading, unzip the file. You'll see a folder called <code style={{ background: "#0b0d11", padding: "1px 5px", borderRadius: 3, color: "#7a849e" }}>extension/</code> — load that folder into Chrome in the next step.
                  </p>
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 12, padding: "20px 24px", marginBottom: "1rem" }}>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#4ade8022", border: "1.5px solid #4ade8060", display: "flex", alignItems: "center", justifyContent: "center", color: "#4ade80", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>2</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: "#fff", marginBottom: 6 }}>Load the extension in Chrome</div>
                  <p style={{ fontSize: 13, color: "#7a849e", marginBottom: 12, lineHeight: 1.6 }}>
                    Open Chrome's extensions page and load the extension folder:
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {[
                      { n: "a", text: <>Open <a href="chrome://extensions" style={{ color: "#4ade80", textDecoration: "none", fontFamily: "monospace", fontSize: 12 }}>chrome://extensions</a> in a new tab (copy-paste the link — Chrome won't let you click it directly).</> },
                      { n: "b", text: <>Turn on <strong style={{ color: "#e2e6f0" }}>Developer mode</strong> using the toggle in the top-right corner of that page.</> },
                      { n: "c", text: <>Click <strong style={{ color: "#e2e6f0" }}>Load unpacked</strong> and select the <code style={{ background: "#0b0d11", padding: "1px 5px", borderRadius: 3, color: "#4ade80" }}>extension/</code> folder you extracted in Step 1.</> },
                      { n: "d", text: <>You should see <strong style={{ color: "#e2e6f0" }}>ApplyPilot</strong> appear in your extension list with a green puzzle-piece icon.</> },
                    ].map(({ n, text }) => (
                      <div key={n} style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 13, color: "#7a849e" }}>
                        <span style={{ background: "#1a1f2e", border: "1px solid #2a3148", borderRadius: 4, padding: "1px 7px", fontSize: 11, color: "#8090b0", flexShrink: 0, marginTop: 1 }}>{n}</span>
                        <span style={{ lineHeight: 1.6 }}>{text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 12, padding: "20px 24px", marginBottom: "1rem" }}>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#4ade8022", border: "1.5px solid #4ade8060", display: "flex", alignItems: "center", justifyContent: "center", color: "#4ade80", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>3</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: "#fff", marginBottom: 6 }}>Log in to your job sites</div>
                  <p style={{ fontSize: 13, color: "#7a849e", marginBottom: 12, lineHeight: 1.6 }}>
                    The bot uses <strong style={{ color: "#e2e6f0" }}>your existing Chrome login sessions</strong> — no passwords stored anywhere. Make sure you're already logged in before pressing Run.
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {[
                      { label: "LinkedIn", url: "https://www.linkedin.com/login" },
                      { label: "Naukri", url: "https://www.naukri.com/nlogin/login" },
                      { label: "Indeed", url: "https://in.indeed.com/account/login" },
                      { label: "Glassdoor", url: "https://www.glassdoor.co.in/profile/login_input.htm" },
                      { label: "Foundit", url: "https://www.foundit.in/login" },
                    ].map(({ label, url }) => (
                      <a key={label} href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#8090b0", background: "#0b0d11", border: "1px solid #1e2330", borderRadius: 5, padding: "5px 12px", textDecoration: "none" }}>
                        {label} ↗
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Step 4 */}
            <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 12, padding: "20px 24px", marginBottom: "2rem" }}>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#4ade8022", border: "1.5px solid #4ade8060", display: "flex", alignItems: "center", justifyContent: "center", color: "#4ade80", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>4</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, color: "#fff", marginBottom: 6 }}>Refresh this page and fill your profile</div>
                  <p style={{ fontSize: 13, color: "#7a849e", lineHeight: 1.6 }}>
                    After loading the extension, refresh this page — the status indicator in the top-right will turn <strong style={{ color: "#4ade80" }}>green</strong>. Then head to the <strong style={{ color: "#e2e6f0" }}>Profile</strong> tab, fill in your details, and press <strong style={{ color: "#e2e6f0" }}>Run now</strong>. The bot opens job sites in new tabs and handles everything from there.
                  </p>
                  <button onClick={() => window.location.reload()} style={{ marginTop: 14, background: "#1a1f2e", color: "#4ade80", border: "1px solid #4ade8040", borderRadius: 6, padding: "7px 18px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
                    ↺ Refresh now
                  </button>
                </div>
              </div>
            </div>

            {/* FAQ */}
            <div style={{ background: "#0b0d11", border: "1px solid #1e2330", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#7a849e", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 12 }}>FAQ</div>
              {[
                ["Is it safe? Do you store my passwords?", "No passwords are ever stored or sent anywhere. The bot logs in using the cookies already in your browser — the same way you're logged in right now."],
                ["Does it work on all job sites?", "Currently supports LinkedIn Easy Apply, Naukri, and Indeed. Glassdoor and Foundit support is coming soon."],
                ["Does my computer need to stay on?", "Yes — the bot runs in your Chrome browser, so keep your computer and browser open while it's running. You can use your computer normally in the meantime."],
                ["What's the Groq API key for?", "Optional. It lets the bot use AI to score each job against your resume and skip poor matches. Free at console.groq.com. Without it, the bot uses keyword matching instead."],
              ].map(([q, a]) => (
                <div key={q} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #1e2330" }}>
                  <div style={{ fontSize: 13, color: "#e2e6f0", marginBottom: 5 }}>{q}</div>
                  <div style={{ fontSize: 12, color: "#7a849e", lineHeight: 1.6 }}>{a}</div>
                </div>
              ))}
              <div style={{ fontSize: 12, color: "#7a849e" }}>
                Still stuck? <a href="https://github.com/ShivUP32/job-apply-agent/issues" target="_blank" rel="noopener noreferrer" style={{ color: "#4ade80" }}>Open an issue on GitHub →</a>
              </div>
            </div>
          </div>
        )}

        {/* ── PROFILE TAB ── */}
        {tab === "profile" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: "1.5rem", color: "#fff" }}>Your profile</h2>

            <Section title="Personal details">
              <Row>
                <Field label="First name" value={profile.first_name} onChange={v => p("first_name", v)} placeholder="e.g. Rahul" />
                <Field label="Last name" value={profile.last_name} onChange={v => p("last_name", v)} placeholder="e.g. Sharma" />
              </Row>
              <Row>
                <Field label="Email" value={profile.email} onChange={v => p("email", v)} placeholder="e.g. you@email.com" type="email" />
                <Field label="Phone" value={profile.phone} onChange={v => p("phone", v)} placeholder="e.g. 9876543210" />
              </Row>
              <Row>
                <Field label="City" value={profile.city} onChange={v => p("city", v)} placeholder="e.g. Bangalore" />
                <Field label="LinkedIn URL" value={profile.linkedin_url} onChange={v => p("linkedin_url", v)} placeholder="e.g. linkedin.com/in/yourprofile" />
              </Row>
              <Row>
                <Field label="Portfolio URL" value={profile.portfolio_url} onChange={v => p("portfolio_url", v)} placeholder="e.g. yourportfolio.com" />
                <Field label="GitHub URL" value={profile.github_url} onChange={v => p("github_url", v)} placeholder="e.g. github.com/yourusername" />
              </Row>
              <Row>
                <Field label="Other URL 1" value={profile.other_url_1} onChange={v => p("other_url_1", v)} placeholder="e.g. behance.net/yourprofile" />
                <Field label="Other URL 2" value={profile.other_url_2} onChange={v => p("other_url_2", v)} placeholder="e.g. dribbble.com/yourprofile" />
              </Row>
            </Section>

            <Section title="Job preferences">
              <div style={{ marginBottom: "1rem" }}>
                <label style={labelStyle}>Target job titles</label>
                {profile.target_roles.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <input value={r} onChange={e => updateRole(i, e.target.value)} placeholder={`e.g. ${["Product Manager","Data Analyst","Software Engineer"][i % 3]}`} style={inputStyle} />
                    {profile.target_roles.length > 1 && (
                      <button onClick={() => removeRole(i)} style={{ background: "none", border: "1px solid #2a3148", borderRadius: 6, color: "#f87171", padding: "0 12px", cursor: "pointer", fontSize: 18 }}>×</button>
                    )}
                  </div>
                ))}
                <button onClick={addRole} style={{ background: "none", border: "1px dashed #2a3148", borderRadius: 6, color: "#7a849e", padding: "6px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>+ Add role</button>
              </div>
              <Row>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Location</label>
                  <select value={profile.target_location} onChange={e => p("target_location", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                    <option value="India">India</option>
                    <option value="Remote">Remote</option>
                    <option value="International">International</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Experience</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1, position: "relative" }}>
                      <input type="number" min={0} max={40} value={profile.experience_years} onChange={e => p("experience_years", parseInt(e.target.value) || 0)} style={{ ...inputStyle, paddingRight: 44 }} />
                      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#7a849e", pointerEvents: "none" }}>yrs</span>
                    </div>
                    <div style={{ flex: 1, position: "relative" }}>
                      <select value={profile.experience_months} onChange={e => p("experience_months", parseInt(e.target.value))} style={{ ...inputStyle, cursor: "pointer", paddingRight: 44 }}>
                        {[...Array(12)].map((_, m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "#7a849e", pointerEvents: "none" }}>mo</span>
                    </div>
                  </div>
                </div>
              </Row>
              <Row>
                <Field label="Current CTC (₹)" value={profile.current_ctc} onChange={v => p("current_ctc", v)} placeholder="1800000" />
                <Field label="Expected CTC (₹)" value={profile.expected_ctc} onChange={v => p("expected_ctc", v)} placeholder="2500000" />
              </Row>
              <Row>
                <Field label="Notice period" value={profile.notice_period} onChange={v => p("notice_period", v)} placeholder="30 days" />
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Min match score: <strong style={{ color: "#4ade80" }}>{profile.min_match_score}%</strong></label>
                  <input type="range" min={40} max={95} value={profile.min_match_score} onChange={e => p("min_match_score", parseInt(e.target.value))}
                    style={{ width: "100%", accentColor: "#4ade80", marginTop: 8 }} />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#7a849e" }}><span>40% (volume)</span><span>95% (quality)</span></div>
                </div>
              </Row>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Max applications per day: <strong style={{ color: "#4ade80" }}>{profile.max_applications}</strong></label>
                <input type="range" min={1} max={50} value={profile.max_applications} onChange={e => p("max_applications", parseInt(e.target.value))}
                  style={{ width: "100%", accentColor: "#4ade80", marginTop: 8 }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#7a849e" }}><span>1</span><span>50</span></div>
              </div>
            </Section>

            <Section title="Resume (plain text)">
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Resume PDF</label>
                <label style={{ display: "block", cursor: "pointer" }}>
                  <input type="file" accept=".pdf" onChange={handlePdfUpload} style={{ display: "none" }} />
                  <div style={{ ...inputStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <span style={{ background: "#1a1f2e", border: "1px solid #2a3148", borderRadius: 4, padding: "3px 10px", fontSize: 12, color: "#e2e6f0", whiteSpace: "nowrap" }}>Choose PDF</span>
                    {profile.resume_pdf_name ? (
                      <span style={{ fontSize: 13, color: "#4ade80" }}>✓ {profile.resume_pdf_name}</span>
                    ) : (
                      <span style={{ fontSize: 13, color: "#3a4060" }}>No file chosen</span>
                    )}
                  </div>
                </label>
                <p style={{ fontSize: 12, color: "#7a849e", marginTop: 6 }}>Bot uses this PDF when job sites ask for resume upload (mandatory on most platforms).</p>
              </div>
              <p style={{ fontSize: 13, color: "#7a849e", marginBottom: 10 }}>Paste your CV as plain text. The AI reads this to score jobs and write cover letters.</p>
              <textarea value={profile.resume_text} onChange={e => p("resume_text", e.target.value)}
                placeholder={"YOUR NAME | Bangalore | you@email.com\n\nSUMMARY\nProduct Manager with 4 years...\n\nEXPERIENCE\nSenior PM — Acme Corp (2022–Present)\n- Led onboarding redesign, reduced time-to-value by 60%\n\nSKILLS\nSQL, Figma, Jira, roadmapping, A/B testing"}
                style={{ ...inputStyle, height: 200, resize: "vertical", fontFamily: "monospace", fontSize: 12 }} />
            </Section>

            <Section title="Google Sheets Setup">
              {/* Step 1: Google Sheet URL */}
              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>Google Sheet URL <span style={{ color: "#f87171" }}>*required for tracking and updates on jobs applied</span></label>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input type="text" value={profile.google_sheet_url} onChange={e => p("google_sheet_url", e.target.value)} placeholder="e.g. https://docs.google.com/spreadsheets/d/..." style={inputStyle} />
                  {profile.google_sheet_url && safeSheetUrl(profile.google_sheet_url) && (
                    <a href={safeSheetUrl(profile.google_sheet_url)} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: "nowrap", fontSize: 12, color: "#4ade80", textDecoration: "none", border: "1px solid #4ade8060", borderRadius: 4, padding: "4px 10px" }}>Open →</a>
                  )}
                </div>
                {profile.google_sheet_url && (
                  <p style={{ fontSize: 12, color: "#4ade80", marginTop: 6 }}>✓ Bot will log every application to this sheet automatically.</p>
                )}
              </div>

              {/* One-time sharing instruction */}
              <div style={{ background: "#0d1a0d", border: "1px solid #4ade8030", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "#4ade80", marginBottom: 10 }}>One-time setup</div>
                {[
                  <>Open your Google Sheet, click <strong style={{ color: "#e2e6f0" }}>Extensions → Apps Script</strong> and paste the ApplyPilot logging script provided in the docs.</>,
                  <>In Apps Script, go to <strong style={{ color: "#e2e6f0" }}>Project Settings → Script Properties</strong> and add <strong style={{ color: "#e2e6f0" }}>TARGET_SHEET_ID</strong> — the long string between <code style={{ background: "#080a0e", padding: "1px 5px", borderRadius: 3 }}>/d/</code> and <code style={{ background: "#080a0e", padding: "1px 5px", borderRadius: 3 }}>/edit</code> in your Sheet URL.</>,
                ].map((step, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 12, color: "#7a849e", marginBottom: i === 0 ? 8 : 0 }}>
                    <span style={{ color: "#4ade80", fontWeight: 600, flexShrink: 0 }}>{i + 1}.</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>

              {/* Column preview */}
              <div style={{ background: "#0b0d11", border: "1px solid #1e2330", borderRadius: 8, padding: "12px 16px" }}>
                <div style={{ fontSize: 12, color: "#7a849e", marginBottom: 8 }}>Columns auto-populated in your sheet:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {["Date", "Company", "Job Title", "Platform", "Job URL", "Match %", "Status", "Notes"].map(col => (
                    <span key={col} style={{ fontSize: 11, background: "#1a1f2e", border: "1px solid #2a3148", borderRadius: 4, padding: "2px 8px", color: "#8090b0" }}>{col}</span>
                  ))}
                </div>
              </div>
            </Section>

            <button onClick={saveProfile} disabled={saving} style={{
              background: saving ? "#1a1f2e" : "#4ade80", color: saving ? "#7a849e" : "#000",
              border: "none", borderRadius: 8, padding: "12px 32px", fontSize: 14, fontWeight: 500,
              cursor: saving ? "default" : "pointer", fontFamily: "inherit", transition: "all .2s",
            }}>
              {saving ? "Saving..." : saved ? "✓ Saved!" : "Save profile"}
            </button>
          </div>
        )}

        {/* ── PLATFORMS TAB ── */}
        {tab === "platforms" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: "0.5rem", color: "#fff" }}>Platforms</h2>
            <p style={{ color: "#7a849e", fontSize: 14, marginBottom: "1.5rem" }}>Select which job sites the agent should apply to.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              {PLATFORMS.map(pl => {
                const on = selectedPlatforms.includes(pl.id);
                return (
                  <div key={pl.id} onClick={() => togglePlatform(pl.id)} style={{
                    background: on ? "#0f2e1a" : "#13161f", border: `1px solid ${on ? "#4ade80" : "#1e2330"}`,
                    borderRadius: 10, padding: "18px 16px", cursor: "pointer", transition: "all .15s",
                  }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>{pl.icon}</div>
                    <div style={{ fontWeight: 500, fontSize: 14, color: on ? "#4ade80" : "#e2e6f0" }}>{pl.label}</div>
                    <div style={{ fontSize: 12, color: "#7a849e", marginTop: 3 }}>{pl.desc}</div>
                    <div style={{ marginTop: 10, width: 16, height: 16, borderRadius: "50%", border: `1.5px solid ${on ? "#4ade80" : "#2a3148"}`, background: on ? "#4ade80" : "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {on && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#000" }} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: "2rem", padding: "16px", background: "#13161f", border: "1px solid #1e2330", borderRadius: 10, fontSize: 13, color: "#7a849e" }}>
              <strong style={{ color: "#e2e6f0" }}>Note:</strong> LinkedIn and Naukri require you to be logged in — Chrome will open and ask you to log in once. After that it remembers the session automatically.
            </div>
          </div>
        )}

        {/* ── SCHEDULE TAB ── */}
        {tab === "schedule" && (() => {
          const BOT_DIR_HINT = "~/Desktop/job-hunt-agent";
          const scriptMap = {
            manual: {
              filename: "applypilot_run.py",
              command: "python3 ~/Downloads/applypilot_run.py",
              content: `"""
ApplyPilot — Manual Run
Run this whenever you want to start applying to jobs.
Usage: python3 ~/Downloads/applypilot_run.py
"""
import os, subprocess, sys

# Update this path if your job-hunt-agent folder is elsewhere
BOT_DIR = os.path.expanduser("~/Desktop/job-hunt-agent")

print("\\n🚀 ApplyPilot starting — applying to jobs now...")
subprocess.run([sys.executable, os.path.join(BOT_DIR, "main.py"), "--auto"], cwd=BOT_DIR)
print("\\n✅ Done! Check your Google Sheet for results.")
`,
            },
            daily_9am: {
              filename: "applypilot_scheduler.py",
              command: "python3 ~/Downloads/applypilot_scheduler.py",
              content: `"""
ApplyPilot — Daily 9am Scheduler
Runs the bot every day at 9:00am. Keep this terminal open.
Usage: python3 ~/Downloads/applypilot_scheduler.py
"""
import os, subprocess, sys, time
from datetime import datetime, timedelta

# Update this path if your job-hunt-agent folder is elsewhere
BOT_DIR = os.path.expanduser("~/Desktop/job-hunt-agent")

print("⏰ ApplyPilot scheduler started — runs every day at 9:00am")
print("   Keep this terminal open. Press Ctrl+C to stop.\\n")

while True:
    now = datetime.now()
    if now.hour == 9 and now.minute == 0:
        print(f"▶ Running bot: {now.strftime('%Y-%m-%d %H:%M')}")
        subprocess.run([sys.executable, os.path.join(BOT_DIR, "main.py"), "--auto"], cwd=BOT_DIR)
        time.sleep(61)
    else:
        next_run = now.replace(hour=9, minute=0, second=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        secs = (next_run - now).total_seconds()
        print(f"⏳ Next run at 9:00am ({int(secs//3600)}h {int((secs%3600)//60)}m away). Waiting...")
        time.sleep(min(secs, 1800))
`,
            },
            twice_daily: {
              filename: "applypilot_scheduler.py",
              command: "python3 ~/Downloads/applypilot_scheduler.py",
              content: `"""
ApplyPilot — Twice Daily Scheduler (9am + 6pm)
Runs the bot at 9:00am and 6:00pm every day. Keep this terminal open.
Usage: python3 ~/Downloads/applypilot_scheduler.py
"""
import os, subprocess, sys, time
from datetime import datetime, timedelta

# Update this path if your job-hunt-agent folder is elsewhere
BOT_DIR = os.path.expanduser("~/Desktop/job-hunt-agent")
RUN_HOURS = [9, 18]  # 9am and 6pm

print("⏰ ApplyPilot scheduler started — runs at 9:00am and 6:00pm daily")
print("   Keep this terminal open. Press Ctrl+C to stop.\\n")

while True:
    now = datetime.now()
    if now.hour in RUN_HOURS and now.minute == 0:
        print(f"▶ Running bot: {now.strftime('%Y-%m-%d %H:%M')}")
        subprocess.run([sys.executable, os.path.join(BOT_DIR, "main.py"), "--auto"], cwd=BOT_DIR)
        time.sleep(61)
    else:
        upcoming = [now.replace(hour=h, minute=0, second=0) for h in RUN_HOURS]
        future = [t if t > now else t + timedelta(days=1) for t in upcoming]
        next_run = min(future)
        secs = (next_run - now).total_seconds()
        label = "9:00am" if next_run.hour == 9 else "6:00pm"
        print(f"⏳ Next run at {label} ({int(secs//3600)}h {int((secs%3600)//60)}m away). Waiting...")
        time.sleep(min(secs, 1800))
`,
            },
            weekdays: {
              filename: "applypilot_scheduler.py",
              command: "python3 ~/Downloads/applypilot_scheduler.py",
              content: `"""
ApplyPilot — Weekdays Scheduler (Mon–Fri 9am)
Runs the bot every weekday at 9:00am. Keep this terminal open.
Usage: python3 ~/Downloads/applypilot_scheduler.py
"""
import os, subprocess, sys, time
from datetime import datetime, timedelta

# Update this path if your job-hunt-agent folder is elsewhere
BOT_DIR = os.path.expanduser("~/Desktop/job-hunt-agent")
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

print("⏰ ApplyPilot scheduler started — runs Mon–Fri at 9:00am")
print("   Keep this terminal open. Press Ctrl+C to stop.\\n")

while True:
    now = datetime.now()
    is_weekday = now.weekday() < 5  # Mon=0, Fri=4
    if is_weekday and now.hour == 9 and now.minute == 0:
        print(f"▶ Running bot: {now.strftime('%Y-%m-%d %H:%M')} ({DAYS[now.weekday()]})")
        subprocess.run([sys.executable, os.path.join(BOT_DIR, "main.py"), "--auto"], cwd=BOT_DIR)
        time.sleep(61)
    else:
        next_run = now.replace(hour=9, minute=0, second=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        while next_run.weekday() >= 5:
            next_run += timedelta(days=1)
        secs = (next_run - now).total_seconds()
        print(f"⏳ Next run: {next_run.strftime('%A %d %b at 9:00am')} ({int(secs//3600)}h away). Waiting...")
        time.sleep(min(secs, 1800))
`,
            },
          };

          const sel = scriptMap[schedule];
          const downloadScript = () => {
            const blob = new Blob([sel.content], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = sel.filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 100);
          };

          return (
            <div>
              <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: "0.5rem", color: "#fff" }}>Schedule</h2>
              <p style={{ color: "#7a849e", fontSize: 14, marginBottom: "1.5rem" }}>How often should the agent apply to jobs? Keep your computer on while it runs.</p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: "1.5rem" }}>
                {SCHEDULES.map(s => {
                  const on = schedule === s.id;
                  return (
                    <div key={s.id} onClick={() => setSchedule(s.id)} style={{
                      background: on ? "#0f2e1a" : "#13161f", border: `1px solid ${on ? "#4ade80" : "#1e2330"}`,
                      borderRadius: 10, padding: "18px 20px", cursor: "pointer", position: "relative",
                    }}>
                      {s.id === "manual" && (
                        <span style={{ position: "absolute", top: 10, right: 12, fontSize: 10, background: "#4ade8022", color: "#4ade80", border: "1px solid #4ade8040", borderRadius: 4, padding: "2px 7px", fontWeight: 600 }}>RECOMMENDED</span>
                      )}
                      <div style={{ fontWeight: 500, fontSize: 14, color: on ? "#4ade80" : "#e2e6f0" }}>{s.label}</div>
                      <div style={{ fontSize: 12, color: "#7a849e", marginTop: 4 }}>{s.desc}</div>
                    </div>
                  );
                })}
              </div>

              <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 10, padding: "20px 24px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "#fff", marginBottom: 4 }}>Download your scheduler script</div>
                    <div style={{ fontSize: 12, color: "#7a849e" }}>
                      Downloads to <code style={{ background: "#0b0d11", padding: "1px 5px", borderRadius: 3 }}>~/Downloads/{sel.filename}</code> — runs from anywhere, no moving required.
                    </div>
                  </div>
                  <button onClick={downloadScript} style={{
                    background: "#4ade80", color: "#000", border: "none", borderRadius: 8,
                    padding: "10px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
                  }}>⬇ Download {sel.filename}</button>
                </div>

                <div style={{ background: "#0b0d11", borderRadius: 6, padding: "12px 16px", marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#7a849e", marginBottom: 6 }}>Run in terminal:</div>
                  <code style={{ fontSize: 13, color: "#4ade80" }}>{sel.command}</code>
                </div>

                <div style={{ background: "#0d1a0d", border: "1px solid #4ade8020", borderRadius: 6, padding: "10px 14px" }}>
                  <div style={{ fontSize: 11, color: "#4ade80", marginBottom: 4, fontWeight: 500 }}>Already have the file in Downloads?</div>
                  <div style={{ fontSize: 11, color: "#7a849e", marginBottom: 6 }}>Just run the same command — no need to download again:</div>
                  <code style={{ fontSize: 13, color: "#4ade80" }}>{sel.command}</code>
                </div>

                {schedule !== "manual" && (
                  <div style={{ marginTop: 12, fontSize: 12, color: "#7a849e" }}>
                    Keep the terminal open while the scheduler runs. It will wake up automatically at the scheduled time.
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── LOGS TAB ── */}
        {tab === "logs" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
              <h2 style={{ fontSize: 20, fontWeight: 500, color: "#fff", margin: 0 }}>Live logs</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {logs.length > 0 && (
                  <button onClick={() => setLogs([])} style={{ background: "none", border: "1px solid #2a3148", borderRadius: 5, color: "#7a849e", padding: "3px 10px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Clear</button>
                )}
                {running && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px #4ade8088", animation: "pulse 1.5s infinite" }} />}
                <span style={{ fontSize: 13, color: running ? "#4ade80" : "#7a849e" }}>{running ? "running..." : "idle"}</span>
              </div>
            </div>
            {!extInstalled && (
              <div style={{ marginBottom: 12, padding: "10px 16px", background: "#1f0a0a", border: "1px solid #f8717140", borderRadius: 8, fontSize: 13, color: "#f87171" }}>
                ⚠ Extension not detected — install the ApplyPilot extension and refresh this page. Then log in to your job sites in Chrome before pressing Run.
              </div>
            )}
            <div ref={logsRef} style={{
              background: "#080a0e", border: "1px solid #1e2330", borderRadius: 10,
              padding: "16px", height: 420, overflowY: "auto", fontFamily: "monospace", fontSize: 12,
            }}>
              {logs.length === 0 && !extInstalled && <span style={{ color: "#f87171" }}>Extension not connected. Install it and refresh.</span>}
              {logs.length === 0 && extInstalled && <span style={{ color: "#3a4060" }}>No logs yet — press Run to start the agent.</span>}
              {logs.map((l, i) => (
                <div key={i} style={{ marginBottom: 4, display: "flex", gap: 12 }}>
                  <span style={{ color: "#3a4060", flexShrink: 0 }}>{l.time}</span>
                  <span style={{ color: l.msg.includes("✅") ? "#4ade80" : l.msg.includes("✗") || l.msg.includes("error") ? "#f87171" : l.msg.includes("⚠") ? "#fbbf24" : "#8090b0" }}>{l.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TRACKER TAB ── */}
        {tab === "tracker" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: "1.5rem", color: "#fff" }}>Today's applications</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: "2rem" }}>
              {[
                ["Applied today", stats.applied_today, "#4ade80", "Jobs the bot has applied to in this session"],
                ["Platforms active", selectedPlatforms.length, "#38bdf8", "Job sites selected to run — e.g. Naukri, LinkedIn"],
                ["Min score", `${profile.min_match_score}%`, "#fbbf24", "AI match threshold — bot skips jobs scoring below this"],
              ].map(([label, val, color, note]) => (
                <div key={label} style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 10, padding: "16px 20px" }}>
                  <div style={{ fontSize: 28, fontWeight: 500, color }}>{val}</div>
                  <div style={{ fontSize: 12, color: "#7a849e", marginTop: 4 }}>{label}</div>
                  <div style={{ fontSize: 11, color: "#3a4060", marginTop: 6, lineHeight: 1.4 }}>{note}</div>
                </div>
              ))}
            </div>
            {stats.applied_jobs.length > 0 ? (
              <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 10, overflow: "hidden" }}>
                {stats.applied_jobs.map((j, i) => (
                  <div key={i} style={{ padding: "12px 20px", borderBottom: i < stats.applied_jobs.length - 1 ? "1px solid #1e2330" : "none", fontSize: 13, color: "#e2e6f0", display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: "#4ade80" }}>✓</span> {j}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#3a4060", fontSize: 14, textAlign: "center", padding: "3rem" }}>No applications yet today. Run the agent to start.</div>
            )}
            {profile.google_sheet_url && (
              <div style={{ marginTop: "1.5rem", padding: "14px 20px", background: "#0f2e1a", border: "1px solid #4ade8040", borderRadius: 10, fontSize: 13, color: "#4ade80" }}>
                ✓ Google Sheets logging active — every application is auto-logged with score, company and status.
              </div>
            )}
          </div>
        )}

      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { height: 4px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #0b0d11; } ::-webkit-scrollbar-thumb { background: #1e2330; border-radius: 3px; }
        input::placeholder, textarea::placeholder { opacity: 0.35; }
        select option { background: #13161f; }
      `}</style>
    </div>
  );
}

const labelStyle = { fontSize: 12, color: "#7a849e", display: "block", marginBottom: 6, letterSpacing: ".03em" };
const inputStyle = { width: "100%", background: "#0b0d11", border: "1px solid #1e2330", borderRadius: 6, padding: "9px 12px", color: "#e2e6f0", fontSize: 13, fontFamily: "inherit", outline: "none" };

function Section({ title, children }) {
  return (
    <div style={{ background: "#13161f", border: "1px solid #1e2330", borderRadius: 12, padding: "20px 24px", marginBottom: "1.5rem" }}>
      <h3 style={{ fontSize: 13, fontWeight: 500, color: "#7a849e", letterSpacing: ".05em", textTransform: "uppercase", marginBottom: "1.25rem" }}>{title}</h3>
      {children}
    </div>
  );
}

function Row({ children }) {
  return <div style={{ display: "flex", gap: 16, marginBottom: "1rem" }}>{children}</div>;
}

function Field({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={labelStyle}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }} style={{ position: "absolute", top: 8, right: 8, background: "#1a1f2e", border: "1px solid #2a3148", borderRadius: 4, color: copied ? "#4ade80" : "#e2e6f0", fontSize: 11, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

export default App;
