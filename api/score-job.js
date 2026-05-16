// Vercel serverless function — proxies job-scoring requests to Groq.
// GROQ_API_KEY is set in Vercel environment variables (never exposed to clients).

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json({ error: "GROQ_API_KEY not configured" }, 503);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { title = "", description = "", target_roles = [], experience_years = 0, resume_text = "" } = body;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{
          role: "user",
          content:
            "Rate how well this job matches the candidate. Reply with ONLY a number 0-100, nothing else.\n\n" +
            `Job title: ${title}\n` +
            `Job description (first 600 chars): ${String(description).slice(0, 600)}\n\n` +
            `Candidate target roles: ${target_roles.join(", ")}\n` +
            `Experience: ${experience_years} years\n` +
            `Resume summary: ${String(resume_text).slice(0, 400)}\n\nScore:`,
        }],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Groq error:", res.status, err);
      return json({ error: `Groq API error ${res.status}` }, 502);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    const score = parseInt(raw, 10);

    return json({ score: isNaN(score) ? null : Math.min(100, Math.max(0, score)) });
  } catch (e) {
    console.error("Score proxy error:", e);
    return json({ error: "Internal error" }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
