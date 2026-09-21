// netlify/functions/pay.js
// Souvs payments: Stripe Checkout for access passes + souvenirs.
// POST { action, ... } -> JSON. Identity is the client-generated userId
// stored in the visitor's own browser. Storage: Netlify Blobs ("souvs-access").
//
// Actions:
//   status   { userId }          -> { hasAccess, pass, expires, freeWeekEligible }
//   checkout { userId, item }     -> { url }  (Stripe Checkout URL)
//   freeweek { userId, email }    -> { hasAccess, pass, expires } (first-time users only;
//                                    stores the email and sends a welcome email)
//
// Env: STRIPE_SECRET_KEY (required for checkout). RESEND_API_KEY (optional: enables the
// automatic welcome email; without it the pass still activates and the skip is logged).
// WELCOME_FROM (optional sender, default "Souvs <hello@souvs.shop>").
// Passes are fulfilled by pay-webhook.js on checkout.session.completed.

const { getStore } = require("@netlify/blobs");

const SITE = "https://souvs.netlify.app";
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// prices in USD cents — the ONLY price source; the client never sets prices.
const PASSES = {
  daily:  { amount: 199,  name: "Souvs day pass",  days: 1 },
  weekly: { amount: 999,  name: "Souvs week pass", days: 7 },
};
// Placeholder lineup — swap for the real souvenirs when ready.
const SOUVENIRS = [
  { id: "pip-plush",    name: "Pip plush",            amount: 2499 },
  { id: "sticker-pack", name: "Critter sticker pack", amount: 699 },
  { id: "souvs-tee",    name: "Souvs NYC tee",        amount: 2999 },
];

const hits = new Map();
function throttle(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
const ipOf = (e) =>
  ((e.headers["x-nf-client-connection-ip"] || e.headers["x-forwarded-for"] || "").split(",")[0] || "").trim();

const ok = (body) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const bad = (code, error) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error }),
});

function findItem(item) {
  if (PASSES[item]) return { kind: "pass", ...PASSES[item] };
  const sv = SOUVENIRS.find((s) => s.id === item);
  if (sv) return { kind: "souvenir", ...sv };
  return null;
}

function getAccessStore() {
  return getStore({
    name: "souvs-access",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

// Automatic welcome email on free-week activation, via Resend.
// Skips gracefully when RESEND_API_KEY is not configured.
async function sendWelcomeEmail(to) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("welcome email skipped: RESEND_API_KEY not configured");
    return;
  }
  const from = process.env.WELCOME_FROM || "Souvs <hello@souvs.shop>";
  const subject = "Your free week of Souvs is on! 🎁";
  const text =
    "Welcome to the crew!\n\n" +
    "Your first week of full Souvs access is activated. Here's what's waiting:\n" +
    "- Chat with Scurry, Rico, Pip and Zippy, your local critter guides\n" +
    "- Unbox mystery perks: dinners, tickets and discounts around NYC\n" +
    "- Meet fellow travelers and locals\n\n" +
    "Open Souvs: https://souvs.shop\n\n" +
    "See you out there,\nthe Souvs crew";
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">' +
    '<div style="background:linear-gradient(135deg,#bfe8f4,#dcc7ec);padding:28px;border-radius:16px 16px 0 0">' +
    '<h1 style="margin:0;font-size:26px">Welcome to the crew! 🎁</h1>' +
    '<p style="margin:8px 0 0;font-size:16px">Your first week of full Souvs access is activated.</p></div>' +
    '<div style="padding:24px 28px;border:1px solid #eee;border-top:0;border-radius:0 0 16px 16px">' +
    "<p>Here's what's waiting for you:</p><ul>" +
    "<li>Chat with <b>Scurry, Rico, Pip and Zippy</b> — your local critter guides</li>" +
    "<li>Unbox <b>mystery perks</b>: dinners, tickets and discounts around NYC</li>" +
    "<li>Meet fellow travelers and locals</li></ul>" +
    '<p><a href="https://souvs.shop" style="display:inline-block;background:#22304a;color:#fff;' +
    'padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:bold">Open Souvs</a></p>' +
    "<p>See you out there,<br>the Souvs crew</p></div></div>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!res.ok) console.log("welcome email failed:", res.status, await res.text().catch(() => ""));
}

async function accessState(userId) {
  const store = getAccessStore();
  const rec = await store.get(`access/${userId}.json`, { type: "json" }).catch(() => null);
  const now = Date.now();
  const eligible = !rec; // first-time users only: any prior pass (paid or free) disqualifies
  if (rec && rec.expires > now) return { hasAccess: true, pass: rec.pass, expires: rec.expires, freeWeekEligible: false };
  return { hasAccess: false, pass: null, expires: 0, freeWeekEligible: eligible };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "method not allowed");
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "bad json");
  }
  const { action, userId, item, email } = body;
  if (!UID_RE.test(userId || "")) return bad(400, "bad user");
  const ip = ipOf(event);

  if (action === "status") {
    return ok(await accessState(userId));
  }

  if (action === "checkout") {
    if (throttle(`co:${ip}`, 10, 10 * 60 * 1000)) return bad(429, "slow down");
    const found = findItem(item);
    if (!found) return bad(400, "unknown item");
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return bad(503, "payments_unconfigured");
    const stripe = require("stripe")(secret);
    const sessionParams = {
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: found.amount,
            product_data: { name: found.name },
          },
          quantity: 1,
        },
      ],
      metadata: { userId, item },
      success_url: SITE + "/?paid=1",
      cancel_url: SITE + "/",
    };
    if (found.kind === "souvenir") {
      sessionParams.shipping_address_collection = { allowed_countries: ["US", "CA", "GB", "BR", "FR", "DE"] };
    }
    try {
      const session = await stripe.checkout.sessions.create(sessionParams);
      return ok({ url: session.url });
    } catch (e) {
      return bad(502, "checkout_failed");
    }
  }

  if (action === "freeweek") {
    // First-time users only: one free 7-day pass per user, tracked server-side.
    // Requires an email address; a welcome email is sent on activation.
    // (Identity is client-generated, so this is a friendly promo, not hardened DRM.)
    if (throttle(`fw:${ip}`, 20, 24 * 60 * 60 * 1000)) return bad(429, "slow down");
    const em = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em) || em.length > 254) return bad(400, "bad_email");
    const store = getAccessStore();
    const rec = await store.get(`access/${userId}.json`, { type: "json" }).catch(() => null);
    if (rec) return bad(409, "not_first_time");
    const now = Date.now();
    const pass = { pass: "freeweek", expires: now + 7 * 86400 * 1000, free: true, claimedAt: now, email: em };
    await store.setJSON(`access/${userId}.json`, pass);
    sendWelcomeEmail(em).catch((e) => console.log("welcome email error:", e && e.message));
    return ok({ hasAccess: true, pass: pass.pass, expires: pass.expires, freeWeekEligible: false });
  }

  return bad(400, "unknown action");
};

// exported for tests
exports._findItem = findItem;
exports._accessState = accessState;

// deploy-trigger: 2026-09-21 rebuild with STRIPE_WEBHOOK_SECRET in Production env
