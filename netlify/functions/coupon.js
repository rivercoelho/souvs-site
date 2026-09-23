// netlify/functions/coupon.js
// Souvs perk-coupon backend. Actions: claim, verify, redeem.
// A claimed perk becomes a unique one-time code. Staff scan the coupon QR
// (or open /.netlify/functions/coupon via the ?redeem= page) to verify and redeem.
// Coupons live in Netlify Blobs (store "souvs-coupons").

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const ALLOWED_ORIGINS = ["https://souvs.netlify.app", "https://souvs.shop", "https://www.souvs.shop"];
function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };
}

// Light per-instance throttle for claim/redeem: max 20 per IP per 10 minutes.
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
function makeCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length];
  return "SOUVS-" + s.slice(0, 4) + "-" + s.slice(4);
}
const CODE_RE = /^SOUVS-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const PERK_RE = /^(nyc|miami):perk[1-7]$/;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function statusOf(cpn) {
  if (!cpn) return "invalid";
  if (cpn.status === "redeemed") return "redeemed";
  if (Date.now() > cpn.expiresAt) return "expired";
  return "valid";
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad request" }) };
  }
  // Allow ?action=verify&code=... for staff links opened from a plain browser.
  const action = body.action || (event.queryStringParameters || {}).action;
  let store;
  try {
    store = getStore({
      name: "souvs-coupons",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
  } catch {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "storage unavailable" }) };
  }
  const ip =
    (event.headers && (event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"]) || "")
      .split(",")[0]
      .trim() || "unknown";

  // ---- verify: read-only, safe for staff to open ----
  if (action === "verify") {
    const code = String(body.code || (event.queryStringParameters || {}).code || "")
      .trim()
      .toUpperCase();
    if (!CODE_RE.test(code)) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: "invalid" }) };
    }
    const cpn = await store.get(`code/${code}.json`, { type: "json" }).catch(() => null);
    const status = statusOf(cpn);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        status,
        title: cpn ? cpn.title : "",
        biz: cpn ? cpn.biz : "",
        perkId: cpn && cpn.perkId ? cpn.perkId : "",
        code,
      }),
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }
  if (throttled(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "slow down" }) };
  }

  // ---- claim: one active coupon per user per perk ----
  if (action === "claim") {
    const userId = String(body.userId || "").slice(0, 64);
    const perkId = String(body.perkId || "");
    const title = String(body.title || "").slice(0, 80);
    const biz = String(body.biz || "").slice(0, 80);
    if (!userId || !PERK_RE.test(perkId) || !title || !biz) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "bad claim" }) };
    }
    const idxKey = `user/${userId}/${perkId}.json`;
    const existingCode = await store.get(idxKey, { type: "json" }).catch(() => null);
    if (existingCode) {
      const cpn = await store.get(`code/${existingCode}.json`, { type: "json" }).catch(() => null);
      if (cpn && statusOf(cpn) === "valid") {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ok: true, code: cpn.code, expiresAt: cpn.expiresAt, reused: true }),
        };
      }
    }
    const now = Date.now();
    const cpn = {
      code: makeCode(),
      userId,
      perkId,
      title,
      biz,
      status: "valid",
      createdAt: now,
      expiresAt: now + EXPIRY_MS,
    };
    await store.setJSON(`code/${cpn.code}.json`, cpn);
    await store.setJSON(idxKey, cpn.code);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, code: cpn.code, expiresAt: cpn.expiresAt }),
    };
  }

  // ---- redeem: staff marks the code used ----
  if (action === "redeem") {
    const code = String(body.code || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "bad code" }) };
    }
    const cpn = await store.get(`code/${code}.json`, { type: "json" }).catch(() => null);
    const status = statusOf(cpn);
    if (status !== "valid") {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status }) };
    }
    cpn.status = "redeemed";
    cpn.redeemedAt = Date.now();
    await store.setJSON(`code/${code}.json`, cpn);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: "redeemed" }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown action" }) };
};
