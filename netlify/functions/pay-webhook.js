// netlify/functions/pay-webhook.js
// Stripe webhook: fulfills checkout.session.completed by writing an access
// pass (daily/weekly) or recording a souvenir order in Blobs ("souvs-access").
//
// Configure in Stripe: endpoint https://souvs.netlify.app/.netlify/functions/pay-webhook
// listening for checkout.session.completed.
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.

const { getStore } = require("@netlify/blobs");

const PASSES = {
  daily:  { days: 1 },
  weekly: { days: 7 },
};
const SOUVENIR_IDS = ["pip-plush", "sticker-pack", "souvs-tee"];
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function fulfill(userId, item, session) {
  const store = getStore("souvs-access");
  if (PASSES[item]) {
    await store.setJSON(`access/${userId}.json`, {
      pass: item,
      expires: Date.now() + PASSES[item].days * 86400 * 1000,
      sessionId: session.id,
      at: Date.now(),
    });
  } else if (SOUVENIR_IDS.includes(item)) {
    await store.setJSON(`order/${session.id}.json`, {
      userId,
      item,
      amount: session.amount_total,
      currency: session.currency,
      email: (session.customer_details && session.customer_details.email) || null,
      shipping: (session.shipping_details && session.shipping_details.address) || null,
      at: Date.now(),
    });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "method not allowed" };
  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) return { statusCode: 503, body: "webhook not configured" };
  const stripe = require("stripe")(secret);
  const sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, whSecret);
  } catch (e) {
    return { statusCode: 400, body: "bad signature" };
  }
  if (stripeEvent.type === "checkout.session.completed") {
    const s = stripeEvent.data.object;
    const userId = s.metadata && s.metadata.userId;
    const item = s.metadata && s.metadata.item;
    if (userId && UID_RE.test(userId) && item) {
      try {
        await fulfill(userId, item, s);
      } catch (e) {
        return { statusCode: 500, body: "fulfill failed" };
      }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

exports._fulfill = fulfill;
