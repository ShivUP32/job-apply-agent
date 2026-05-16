"""
system_config.py — ApplyPilot AI Layer
Groq-powered job scoring, cover letter generation, and Q&A answering.
Falls back to Gemini if Groq hits its daily limit.
"""

import json
import re
import logging
import urllib.request
import urllib.error

import config

log = logging.getLogger(__name__)

GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent"


# ── Internal LLM callers ──────────────────────────────────────

def _call_groq(prompt: str, max_tokens: int = 400) -> str:
    key = config.AI.get("groq_api_key", "")
    if not key or key.startswith("gsk_xxx"):
        raise ValueError("Groq API key not configured")

    body = json.dumps({
        "model":      config.AI.get("model", "llama-3.3-70b-versatile"),
        "messages":   [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.3,
    }).encode()

    req = urllib.request.Request(
        GROQ_URL, data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"].strip()


def _call_gemini(prompt: str, max_tokens: int = 400) -> str:
    key = config.AI.get("gemini_api_key", "")
    if not key:
        raise ValueError("Gemini API key not configured")

    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.3},
    }).encode()

    req = urllib.request.Request(
        f"{GEMINI_URL}?key={key}", data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["candidates"][0]["content"]["parts"][0]["text"].strip()


def _llm(prompt: str, max_tokens: int = 400) -> str:
    """Call Groq; fall back to Gemini on rate limit."""
    try:
        return _call_groq(prompt, max_tokens)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            log.warning("Groq rate limited — falling back to Gemini")
            return _call_gemini(prompt, max_tokens)
        raise
    except ValueError:
        return _call_gemini(prompt, max_tokens)


# ── Public API ────────────────────────────────────────────────

def score_job(job_title: str, job_description: str) -> dict:
    """
    Score a job against the user's resume.
    Returns {"score": int, "reason": str, "missing": list, "keywords": list}.
    Returns {"score": -1} if AI is disabled or unavailable.
    """
    if not config.AI.get("enabled", True):
        return {"score": -1, "reason": "AI disabled", "missing": [], "keywords": []}

    resume = config.AI.get("resume_text", "")[:2000]
    jd     = (job_description or job_title)[:2000]

    prompt = f"""Score how well this resume matches the job (0–100).

Scoring guide:
- 80–100  Strong match — most key requirements met
- 60–79   Decent match — several requirements met
- 0–59    Poor match — too many gaps

Return ONLY valid JSON, no markdown:
{{"score": <int>, "reason": "<one sentence>", "missing": ["gap1"], "keywords": ["skill1"]}}

JOB TITLE: {job_title}
JOB DESCRIPTION: {jd}
RESUME: {resume}"""

    try:
        raw = re.sub(r"```json|```", "", _llm(prompt, max_tokens=250)).strip()
        return json.loads(raw)
    except Exception as e:
        log.warning(f"Score parse error: {e}")
        return {"score": -1, "reason": "Parse error", "missing": [], "keywords": []}


def generate_cover_letter(job_title: str, company: str, job_description: str) -> str:
    """Generate a concise, personalised cover letter for a specific job."""
    if not config.AI.get("enabled", True):
        return config.SAVED_ANSWERS.get("cover letter", "")

    resume = config.AI.get("resume_text", "")[:1500]
    tone   = config.AI.get("cover_letter_tone", "professional but warm")
    jd     = (job_description or "")[:1200]

    prompt = f"""Write a concise cover letter.
Tone: {tone}
Length: 3 short paragraphs, max 180 words.
Start with "Dear Hiring Manager,"
Do NOT use: "I am writing to", subject lines, or filler phrases.

JOB: {job_title} at {company}
JOB DESCRIPTION: {jd}
RESUME: {resume}"""

    try:
        return _llm(prompt, max_tokens=320)
    except Exception as e:
        log.warning(f"Cover letter generation failed: {e}")
        return config.SAVED_ANSWERS.get("cover letter", "")


def answer_question(question_text: str) -> str:
    """
    AI fallback for screening questions not matched by SAVED_ANSWERS.
    Returns a short, truthful answer based on the user's resume and config.
    """
    if not config.AI.get("enabled", True):
        return "Yes"

    resume = config.AI.get("resume_text", "")[:800]
    exp    = config.EXPERIENCE.get("total_years", "4")
    notice = config.WORK_AUTH.get("notice_period", "30 days")

    prompt = f"""Answer this job application screening question in 50 words or fewer.
Be concise and truthful.

Question: {question_text}
Context: {exp} years of experience, notice period {notice}.
Resume (excerpt): {resume[:400]}

Answer:"""

    try:
        return _llm(prompt, max_tokens=80)
    except Exception as e:
        log.warning(f"AI Q&A failed: {e}")
        return "Yes"
