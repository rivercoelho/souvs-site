// netlify/functions/chat.js
// Souvs real-AI guide backend. POST { critter, message, history, lang } -> { reply }.
// lang: en | es | pt | fr | de (defaults to en).
// Requires OPENAI_API_KEY as a Netlify environment variable.

const CRITTERS = {
  souvs: {
    name: "Souvs",
    system: [
      "You are Souvs, the friendly AI city guide of the Souvs app, covering New York City and Miami.",
      "GOAL: help travelers explore the city - events, deals, happy hours, neighborhoods, routes, food, hidden spots.",
      "VOICE: warm, casual, upbeat, concise; a knowledgeable local friend. Never stiff or corporate.",
      "Cover both NYC and Miami fluently; tailor answers to the traveler's city when known.",
      "Answer first, add one useful local detail, offer one next action.",
      "BOUNDARIES: never encourage trespassing, unsafe areas, fare evasion, unsafe food handling, feeding wildlife, ignoring park rules or closures, risky rooftop access, or unsafe boating/swimming.",
      "Never state unverified hours or prices as fact - hedge when unsure.",
      "STYLE: answer first, add one useful local detail, offer one next action.",
      "Keep replies under ~120 words.",
    ].join(" "),
  },
};


// CORS: only allow requests from our own domains
const ALLOWED_ORIGINS = ["https://souvs.netlify.app", "https://souvs.shop", "https://www.souvs.shop"];
function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

// Rate limit: 20 AI replies per 60s per IP, per warm function instance.
// The frontend falls back to canned guide replies on any non-OK response,
// so a 429 degrades gracefully instead of breaking chat.
const RL_WINDOW_MS = 60000;
const RL_MAX = 20;
const rlHits = new Map();
function clientIp(event) {
  const h = event.headers || {};
  return (
    h["x-nf-client-connection-ip"] ||
    String(h["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}
function overLimit(ip) {
  const now = Date.now();
  let rec = rlHits.get(ip);
  if (!rec || now - rec.start > RL_WINDOW_MS) {
    rec = { start: now, count: 0 };
    rlHits.set(ip, rec);
  }
  rec.count += 1;
  if (rlHits.size > 4000) {
    for (const [k, v] of rlHits) if (now - v.start > RL_WINDOW_MS) rlHits.delete(k);
  }
  return rec.count > RL_MAX;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  if (overLimit(clientIp(event))) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "slow down" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad request" }) };
  }

  const critter = CRITTERS[body.critter] || CRITTERS.souvs;
  const LANG_NAMES = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German" };
  const lang = LANG_NAMES[body.lang] ? body.lang : "en";
  const langRule = lang === "en" ? "" : " Respond ONLY in " + LANG_NAMES[lang] + ". Keep the same personality, voice, and catchphrases (translated where natural).";
  const message = String(body.message || "").slice(0, 600).trim();
  if (!message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "empty message" }) };
  }
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }))
    : [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "AI not configured" }) };
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 280,
      temperature: 0.8,
      messages: [
        { role: "system", content: critter.system + langRule },
        ...history,
        { role: "user", content: message },
      ],
    }),
  });

  if (!resp.ok) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "AI provider error" }) };
  }
  const data = await resp.json();
  const reply = (data.choices && data.choices[0] && data.choices[0].message.content || "").trim();
  return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
};
