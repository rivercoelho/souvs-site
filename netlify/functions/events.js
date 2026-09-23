// netlify/functions/events.js
// Souvs events & hangouts RSVP backend. Actions: attendees, rsvp, unrsvp.
// Attendee lists live in Netlify Blobs (store "souvs-events"), one blob per event.

const { getStore } = require("@netlify/blobs");

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

// Light per-instance throttle: max 30 requests per IP per 10 minutes.
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

// Curated event ids only — matches the EVENTS list in index.html.
const EVENT_RE = /^(nyc|miami)-[a-z0-9-]{1,40}$/;

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad request" }) };
  }

  const action = body.action;
  const eventId = String(body.eventId || "");
  if (!EVENT_RE.test(eventId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad event" }) };
  }

  const ip =
    (event.headers && (event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"]) || "")
      .split(",")[0]
      .trim() || "unknown";
  if (throttled(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "slow down" }) };
  }

  let store;
  try {
    store = getStore({
      name: "souvs-events",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
  } catch {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "storage unavailable" }) };
  }

  const key = "attendees/" + eventId + ".json";
  let list = [];
  try {
    list = (await store.get(key, { type: "json" })) || [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  // Attach each attendee's current profile avatar (photo or preset character)
  // by looking up their traveler profile in the souvs-meet store.
  let meetStore = null;
  function getMeetStore() {
    if (!meetStore) {
      meetStore = getStore({
        name: "souvs-meet",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN,
      });
    }
    return meetStore;
  }
  async function enrichAttendees(arr) {
    const ms = getMeetStore();
    return Promise.all(
      arr.map(async (a) => {
        let avatarPreset = null;
        let hasPhoto = false;
        try {
          const c = await ms.get(`traveler/${a.userId}.json`, { type: "json" });
          if (c) {
            if (Number.isInteger(c.avatarPreset)) avatarPreset = c.avatarPreset;
            hasPhoto = (c.avatarAt || 0) > 0;
          }
        } catch {}
        return { userId: a.userId, name: a.name, at: a.at, avatarPreset, hasPhoto };
      })
    );
  }

  if (action === "attendees") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attendees: await enrichAttendees(list) }) };
  }

  if (action === "rsvp") {
    const userId = String(body.userId || "").slice(0, 64);
    const name = String(body.name || "").slice(0, 24).trim();
    if (!userId || !name) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "bad profile" }) };
    }
    if (!list.some((a) => a.userId === userId)) {
      list.push({ userId, name, at: Date.now() });
      await store.setJSON(key, list);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attendees: await enrichAttendees(list) }) };
  }

  if (action === "unrsvp") {
    const userId = String(body.userId || "").slice(0, 64);
    const next = list.filter((a) => a.userId !== userId);
    if (next.length !== list.length) await store.setJSON(key, next);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attendees: await enrichAttendees(next) }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: "bad action" }) };
};
