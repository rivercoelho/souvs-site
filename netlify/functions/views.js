// netlify/functions/views.js
// Anonymous page-view counter for souvs.shop.
// POST { action:"hit", city } -> records one anonymous view (total + per-day + per-city).
// GET ?action=stats -> { total, today, cities, days } (aggregate only, no personal data).
// No cookies. Bots are not counted. Max one counted hit per IP per 5 minutes.
// Storage: Netlify Blobs store "souvs-views". No extra accounts or API keys needed.

const { getStore } = require("@netlify/blobs");

const ALLOWED_ORIGINS = ["https://souvs.netlify.app", "https://souvs.shop", "https://www.souvs.shop"];
function corsHeaders(event, methods) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": methods,
    "Content-Type": "application/json",
  };
}
const ok = (headers, obj) => ({ statusCode: 200, headers, body: JSON.stringify(obj) });
const err = (headers, code, msg) => ({ statusCode: code, headers, body: JSON.stringify({ error: msg }) });

// Known crawlers/bots: never counted as views.
const BOT_RE = /bot|crawl|spider|slurp|mediapartners|adsbot|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|perplexity|bytespider|facebookexternalhit|twitterbot|linkedinbot|embedly|quora|pinterest|slackbot|discordbot|telegrambot|whatsapp|google-inspection/i;

// Light per-instance throttle: max one counted hit per IP per 5 minutes.
const lastHit = new Map();
function throttled(ip) {
  const now = Date.now();
  const last = lastHit.get(ip) || 0;
  if (now - last < 5 * 60 * 1000) return true;
  lastHit.set(ip, now);
  return false;
}

function dayKey(d) {
  return (d || new Date()).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function store() {
  return getStore({
    name: "souvs-views",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

exports.handler = async (event) => {
  const headers = corsHeaders(event, "GET, POST, OPTIONS");
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // ---- record a view ----
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return err(headers, 400, "bad request");
    }
    if (body.action !== "hit") return err(headers, 400, "bad request");

    const ua = event.headers["user-agent"] || event.headers["User-Agent"] || "";
    if (BOT_RE.test(ua)) return ok(headers, { ok: true, skipped: "bot" });

    const ip =
      (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    if (ip && throttled(ip)) return ok(headers, { ok: true, skipped: "throttled" });

    const city = body.city === "miami" ? "miami" : "nyc";
    const day = dayKey();
    try {
      const s = store();
      const [totalRaw, dayRaw, cityRaw] = await Promise.all([
        s.get("total"),
        s.get("day/" + day),
        s.get("city/" + city),
      ]);
      const total = (parseInt(totalRaw || "0", 10) || 0) + 1;
      const dayCount = (parseInt(dayRaw || "0", 10) || 0) + 1;
      const cityCount = (parseInt(cityRaw || "0", 10) || 0) + 1;
      await Promise.all([
        s.set("total", String(total)),
        s.set("day/" + day, String(dayCount)),
        s.set("city/" + city, String(cityCount)),
      ]);
      return ok(headers, { ok: true, total });
    } catch (e) {
      return err(headers, 500, "storage unavailable");
    }
  }

  // ---- read aggregate stats ----
  if (event.httpMethod === "GET") {
    const action = (event.queryStringParameters || {}).action;
    if (action !== "stats") return err(headers, 400, "bad request");
    try {
      const s = store();
      const [totalRaw, dayList, cityList] = await Promise.all([
        s.get("total"),
        s.list({ prefix: "day/" }),
        s.list({ prefix: "city/" }),
      ]);
      const days = {};
      for (const b of (dayList.blobs || [])) {
        const v = await s.get(b.key);
        days[b.key.slice(4)] = parseInt(v || "0", 10) || 0;
      }
      const cities = {};
      for (const b of (cityList.blobs || [])) {
        const v = await s.get(b.key);
        cities[b.key.slice(5)] = parseInt(v || "0", 10) || 0;
      }
      const today = dayKey();
      return ok(headers, {
        ok: true,
        total: parseInt(totalRaw || "0", 10) || 0,
        today: days[today] || 0,
        cities,
        days,
      });
    } catch (e) {
      return err(headers, 500, "storage unavailable");
    }
  }

  return err(headers, 405, "method not allowed");
};
