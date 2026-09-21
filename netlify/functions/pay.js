// netlify/functions/pay.js
// Souvs payments: Stripe Checkout for access passes + souvenirs.
// POST { action, ... } -> JSON. Identity is the client-generated userId
// stored in the visitor's own browser. Storage: Netlify Blobs ("souvs-access").
//
// Actions:
//   status   { userId }          -> { hasAccess, pass, expires }
//   checkout { userId, item }     -> { url }  (Stripe Checkout URL)
//
// Env: STRIPE_SECRET_KEY (required for checkout). Passes are fulfilled by
// pay-webhook.js on checkout.session.completed.

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

async function accessState(userId) {
  const store = getAccessStore();
  const rec = await store.get(`access/${userId}.json`, { type: "json" }).catch(() => null);
  const now = Date.now();
  if (rec && rec.expires > now) return { hasAccess: true, pass: rec.pass, expires: rec.expires };
  return { hasAccess: false, pass: null, expires: 0 };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "method not allowed");
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "bad json");
  }
  const { action, userId, item } = body;
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

  return bad(400, "unknown action");
};

// exported for tests
exports._findItem = findItem;
exports._accessState = accessState;

// deploy-trigger: 2026-09-21 STRIPE_SECRET_KEY added — rebuild to pick up env
