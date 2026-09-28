// netlify/functions/signup.js
// Souvs beta-signup backend. POST { name, email, city, critter } -> { ok: true }.
// Stores each signup as JSON in Netlify Blobs (store "souvs-signups").
// No extra accounts or API keys needed: Blobs work automatically on Netlify.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const CITIES = ["New York City", "Miami", "Chicago", "Los Angeles", "San Francisco"];
const CRITTERS = ["scurry", "rico", "pip", "zippy", ""];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Light per-instance throttle: max 5 signups per IP per 10 minutes.
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 5;
}


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

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad request" }) };
  }

  // Honeypot: bots fill it, humans never see it -> pretend success, store nothing.
  if (body.website) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const name = String(body.name || "").trim().slice(0, 80);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const city = String(body.city || "");
  const critter = String(body.critter || "");

  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "name required" }) };
  }
  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "valid email required" }) };
  }
  if (!CITIES.includes(city)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown city" }) };
  }
  if (!CRITTERS.includes(critter)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown critter" }) };
  }

  const ip =
    (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
  if (ip && throttled(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "slow down" }) };
  }

  // Key by email hash so re-signups update the same record instead of duplicating.
  const key =
    "signup/" + crypto.createHash("sha256").update(email).digest("hex") + ".json";
  const record = {
    name,
    email,
    city,
    critter: critter || null,
    createdAt: new Date().toISOString(),
    ip: ip || null,
  };

  try {
    const store = getStore({
      name: "souvs-signups",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    await store.setJSON(key, record);
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "storage unavailable" }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
