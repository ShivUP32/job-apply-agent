import { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Central webhook URL — deploy the Apps Script below once, then replace this value with your deployment URL
const DEFAULT_WEBHOOK_URL = import.meta.env.VITE_SHEETS_WEBHOOK_URL || "";

// Secret token sent with every request — must match WEBHOOK_SECRET in Apps Script Properties
const WEBHOOK_SECRET = import.meta.env.VITE_SHEETS_WEBHOOK_SECRET || "";

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
  const [tab, setTab] = useState("profile");
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ applied_today: 0, applied_jobs: [] });
  const [backendOk, setBackendOk] = useState(null);
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
    resume_pdf_data: "",
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

  // Check backend health
  useEffect(() => {
    fetch(`${API}/health`).then(r => r.json()).then(() => setBackendOk(true)).catch(() => setBackendOk(false));
  }, []);

  // Poll logs + status when running
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const [l, s] = await Promise.all([
          fetch(`${API}/logs`).then(r => r.json()),
          fetch(`${API}/status`).then(r => r.json()),
        ]);
        setLogs(l.logs || []);
        setRunning(l.running);
        setStats(s);
        if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [running]);

  // Also fetch status on mount
  useEffect(() => {
    fetch(`${API}/status`).then(r => r.json()).then(s => { setStats(s); setRunning(s.running); }).catch(() => {});
    fetch(`${API}/logs`).then(r => r.json()).then(l => { setLogs(l.logs || []); setRunning(l.running); }).catch(() => {});
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

  const saveProfile = async () => {
    if (!profile.first_name.trim() || !profile.email.trim()) {
      alert("First name and email are required before saving.");
      return;
    }
    if (!profile.target_roles.some(r => r.trim())) {
      alert("Add at least one target job title before saving.");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...profile, platforms: selectedPlatforms, sheets_webhook_url: DEFAULT_WEBHOOK_URL, sheets_webhook_secret: WEBHOOK_SECRET };
      const r = await fetch(`${API}/save-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.ok) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    } catch (e) { alert("Could not reach backend. Is it running?"); }
    setSaving(false);
  };

  const startBot = async () => {
    setTab("logs");
    setLogs([]);
    const r = await fetch(`${API}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selectedPlatforms),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    if (r.ok) setRunning(true);
  };

  const stopBot = async () => {
    await fetch(`${API}/stop`, { method: "POST" }).catch(() => {});
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
          {[["profile","Profile"],["platforms","Platforms"],["schedule","Schedule"],["logs","Logs"],["tracker","Tracker"]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              background: tab === id ? "#1a1f2e" : "none",
              border: tab === id ? "1px solid #2a3148" : "1px solid transparent",
              borderRadius: 6, padding: "5px 14px", color: tab === id ? "#fff" : "#7a849e",
              cursor: "pointer", fontSize: 13, fontFamily: "inherit",
            }}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: backendOk === null ? "#7a849e" : backendOk ? "#4ade80" : "#f87171", boxShadow: backendOk ? "0 0 8px #4ade8088" : "none" }} />
          <span style={{ fontSize: 12, color: "#7a849e" }}>{backendOk === null ? "checking..." : backendOk ? "backend connected" : "backend offline"}</span>
        </div>
        {running ? (
          <button onClick={stopBot} style={{ background: "#3f1515", border: "1px solid #f87171", color: "#f87171", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>⏹ Stop</button>
        ) : (
          <button onClick={startBot} style={{ background: "#0f2e1a", border: "1px solid #4ade80", color: "#4ade80", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", opacity: backendOk ? 1 : 0.4 }}>▶ Run now</button>
        )}
      </nav>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>

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
                <input type="range" min={5} max={50} value={profile.max_applications} onChange={e => p("max_applications", parseInt(e.target.value))}
                  style={{ width: "100%", accentColor: "#4ade80", marginTop: 8 }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#7a849e" }}><span>5</span><span>50</span></div>
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
                  <>In your Google Sheet: click <strong style={{ color: "#e2e6f0" }}>Share</strong> → add <span style={{ background: "#1a1f2e", border: "1px solid #2a3148", borderRadius: 4, padding: "1px 7px", color: "#4ade80", fontFamily: "monospace", fontSize: 11 }}>itsshiv555@gmail.com</span> → set role to <strong style={{ color: "#e2e6f0" }}>Editor</strong> → Send.</>,
                  <>Copy your Sheet ID from the URL (the long string between <code style={{ background: "#080a0e", padding: "1px 5px", borderRadius: 3 }}>/d/</code> and <code style={{ background: "#080a0e", padding: "1px 5px", borderRadius: 3 }}>/edit</code>) and add it as <strong style={{ color: "#e2e6f0" }}>TARGET_SHEET_ID</strong> in the Apps Script Script Properties.</>,
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
            {backendOk === false && (
              <div style={{ marginBottom: 12, padding: "10px 16px", background: "#1f0a0a", border: "1px solid #f8717140", borderRadius: 8, fontSize: 13, color: "#f87171" }}>
                ⚠ Backend offline — start it with <code style={{ background: "#0b0d11", padding: "1px 6px", borderRadius: 3 }}>python3 backend/server.py</code> then refresh.
              </div>
            )}
            <div ref={logsRef} style={{
              background: "#080a0e", border: "1px solid #1e2330", borderRadius: 10,
              padding: "16px", height: 420, overflowY: "auto", fontFamily: "monospace", fontSize: 12,
            }}>
              {logs.length === 0 && backendOk === false && <span style={{ color: "#f87171" }}>Backend not connected. No logs to show.</span>}
              {logs.length === 0 && backendOk !== false && <span style={{ color: "#3a4060" }}>No logs yet — press Run to start the agent.</span>}
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
            {(DEFAULT_WEBHOOK_URL && profile.google_sheet_url) && (
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
