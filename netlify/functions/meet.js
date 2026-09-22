// netlify/functions/meet.js
// Souvs traveler-to-traveler chat backend (simple polling, no accounts).
// POST { action, ... } -> JSON. Identity is a client-generated userId
// stored in the visitor's own browser. Storage: Netlify Blobs ("souvs-meet").
//
// Actions:
//   register  { userId, name, kind, tag, note, socials, avatarAt, lat?, lng? } -> upsert profile
//   avatar    { userId, data }  -> upload profile photo (raw base64 of a small
//             JPEG; client resizes to <=256px). Empty data removes the photo.
//   GET ?action=avatar&userId=... -> serves the profile photo (image/jpeg)
//   travelers { userId, lat?, lng? }                   -> list live profiles, nearest first
//   remove    { userId }                                -> delete profile + photo
//   thread    { userId, otherId }                    -> get-or-create thread
//   threads   { userId }                             -> my threads w/ preview
//   messages  { userId, threadId, since }            -> messages after `since`
//   send      { userId, threadId, text }             -> post a message
//   block     { userId, blockedId }                  -> block a user
//   report    { userId, reportedId, reason }         -> report + auto-block

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const KINDS = ["traveler", "local"];
const TAGS = [
  "art walk",
  "food crawl",
  "first visit",
  "photo spots",
  "parks & picnic",
  "nightlife",
  "shopping",
  "just wandering",
];
const REASONS = ["spam", "harassment", "inappropriate", "scam", "other"];
const UID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NAME_RE = /^[A-Za-z0-9 _.'-]{1,24}$/;
const HANDLE_RE = /^[A-Za-z0-9._-]{1,30}$/;
const CARD_TTL_MS = 14 * 24 * 3600 * 1000;
const ONLINE_WINDOW_MS = 4 * 60 * 1000; // green "online" dot: seen in the last 4 minutes

// socials: only handles we can turn into real platform links (never raw user URLs)
const SOCIALS = {
  instagram: "instagram.com",
  tiktok: "tiktok.com",
  x: "x.com",
};
function cleanHandle(platform, raw) {
  var v = String(raw == null ? "" : raw).trim().replace(/^@+/, "");
  if (!v || /\s/.test(v)) return ""; // handles never contain whitespace
  var domain = SOCIALS[platform];
  var m = v.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)?(?:instagram\.com|tiktok\.com|x\.com))([\/\?#]|$)/i);
  if (m) {
    var host = m[1].toLowerCase();
    if (host !== domain && host.slice(-domain.length - 1) !== "." + domain) return "";
    var rest = v.slice(m[0].length);
    var segs = rest.split("?")[0].split("#")[0].split("/").filter(function (p) { return p; });
    v = (segs.length ? segs[segs.length - 1] : "").replace(/^@+/, "");
    if (!v) return "";
  }
  return HANDLE_RE.test(v) ? v : "";
}
function cleanSocials(obj) {
  var out = {};
  if (obj && typeof obj === "object") {
    for (var p in SOCIALS) {
      var h = cleanHandle(p, obj[p]);
      if (h) out[p] = h;
    }
  }
  return out;
}

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const ok = (body) => ({ statusCode: 200, headers, body: JSON.stringify(body) });
const bad = (code, error) => ({ statusCode: code, headers, body: JSON.stringify({ error }) });

// light per-instance throttle
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

const threadIdFor = (a, b) =>
  crypto.createHash("sha256").update([a, b].sort().join(":")).digest("hex").slice(0, 32);

async function getBlocks(store, userId) {
  return (await store.get(`blocks/${userId}.json`, { type: "json" }).catch(() => null)) || [];
}
async function blockedEither(store, a, b) {
  const [ba, bb] = await Promise.all([getBlocks(store, a), getBlocks(store, b)]);
  return ba.includes(b) || bb.includes(a);
}
async function getCard(store, userId) {
  return store.get(`traveler/${userId}.json`, { type: "json" }).catch(() => null);
}
const publicCard = (c) =>
  c
    ? {
        userId: c.userId,
        name: c.name,
        kind: c.kind,
        tag: c.tag,
        note: c.note,
        openTo: c.openTo && typeof c.openTo === "object"
          ? { travelers: !!c.openTo.travelers, friends: !!c.openTo.friends }
          : { travelers: true, friends: true },
        socials: cleanSocials(c.socials),
        avatar: (c.avatarAt || 0) > 0,
        avatarAt: c.avatarAt || 0,
        gender: c.gender === "female" ? "female" : c.gender === "male" ? "male" : "",
        online: (c.seenAt || 0) > Date.now() - ONLINE_WINDOW_MS,
      }
    : null;

// great-circle distance in km; viewer coords validated at call sites
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const s1 = Math.sin(((lat2 - lat1) / 2) * rad);
  const s2 = Math.sin(((lng2 - lng1) / 2) * rad);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * s2 * s2));
}
function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  let store;
  try {
    store = getStore({
      name: "souvs-meet",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
  } catch {
    return bad(500, "storage unavailable");
  }

  // ---- public avatar image (GET ?action=avatar&userId=...) ----
  if (event.httpMethod === "GET") {
    const qs = event.queryStringParameters || {};
    if (qs.action !== "avatar") return bad(400, "unknown action");
    const userId = String(qs.userId || "");
    if (!UID_RE.test(userId)) return bad(400, "bad user");
    const buf = await store.get(`avatar/${userId}.bin`, { type: "arrayBuffer" }).catch(() => null);
    if (!buf) return bad(404, "no avatar");
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
      body: Buffer.from(buf).toString("base64"),
      isBase64Encoded: true,
    };
  }

  if (event.httpMethod !== "POST") return bad(405, "POST only");

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "bad request");
  }
  const action = body.action;
  const userId = String(body.userId || "");
  if (!UID_RE.test(userId)) return bad(400, "bad user");
  const ip = ipOf(event);

  // ---- register / update profile ----
  if (action === "register") {
    if (throttle(`reg:${ip}`, 5, 10 * 60 * 1000)) return bad(429, "slow down");
    const name = String(body.name || "").trim();
    const kind = String(body.kind || "");
    const tag = String(body.tag || "");
    const note = String(body.note || "").trim().slice(0, 140);
    if (!NAME_RE.test(name)) return bad(400, "bad name");
    if (!KINDS.includes(kind)) return bad(400, "bad kind");
    if (!TAGS.includes(tag)) return bad(400, "bad tag");
    let email = null;
    if (body.email !== undefined) {
      const e = String(body.email || "").trim().toLowerCase().slice(0, 120);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return bad(400, "bad email");
      email = e;
    }
    let openTo = null;
    if (body.openTo && typeof body.openTo === "object") {
      openTo = { travelers: !!body.openTo.travelers, friends: !!body.openTo.friends };
    }
    let socials = null;
    if (body.socials && typeof body.socials === "object") socials = cleanSocials(body.socials);
    let gender = null;
    if (body.gender !== undefined) {
      const g = String(body.gender || "").trim().toLowerCase();
      if (g && g !== "female" && g !== "male") return bad(400, "bad gender");
      gender = g;
    }
    let lat = null, lng = null;
    if (body.lat !== undefined || body.lng !== undefined) {
      const la = Number(body.lat), lo = Number(body.lng);
      if (!validCoords(la, lo)) return bad(400, "bad location");
      lat = Math.round(la * 10000) / 10000;
      lng = Math.round(lo * 10000) / 10000;
    }
    const prev = await store.get(`traveler/${userId}.json`, { type: "json" }).catch(() => null);
    const card = { userId, name, kind, tag, note, updatedAt: Date.now(), seenAt: Date.now() };
    card.openTo = openTo || (prev && prev.openTo) || { travelers: true, friends: true };
    card.socials = socials || (prev && prev.socials) || {};
    card.gender = gender !== null ? gender : (prev && prev.gender) || "";
    card.email = email !== null ? email : (prev && prev.email) || "";
    if (lat !== null) { card.lat = lat; card.lng = lng; }
    else if (prev && validCoords(prev.lat, prev.lng)) { card.lat = prev.lat; card.lng = prev.lng; }
    let avatarAt = null;
    if (body.avatarAt !== undefined) {
      const n = Number(body.avatarAt);
      avatarAt = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
    card.avatarAt = avatarAt !== null ? avatarAt : (prev && prev.avatarAt) || 0;
    await store.setJSON(`traveler/${userId}.json`, card);
    return ok({ ok: true, card: publicCard(card) });
  }

  // ---- delete profile ----
  if (action === "remove") {
    if (throttle(`rm:${ip}`, 5, 10 * 60 * 1000)) return bad(429, "slow down");
    await store.delete(`traveler/${userId}.json`).catch(() => {});
    await store.delete(`avatar/${userId}.bin`).catch(() => {});
    return ok({ ok: true });
  }

  // ---- upload / remove profile photo ----
  // POST { action:"avatar", userId, data } — data is raw base64 of a small JPEG
  // (client resizes to <=256px). Empty data removes the photo.
  if (action === "avatar") {
    if (throttle(`av:${ip}`, 10, 10 * 60 * 1000)) return bad(429, "slow down");
    const data = String(body.data || "");
    const prev = await getCard(store, userId);
    if (!data) {
      await store.delete(`avatar/${userId}.bin`).catch(() => {});
      if (prev) {
        prev.avatarAt = 0;
        await store.setJSON(`traveler/${userId}.json`, prev);
      }
      return ok({ ok: true, avatarAt: 0 });
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length % 4 !== 0) return bad(400, "bad image");
    const buf = Buffer.from(data, "base64");
    if (buf.length > 200 * 1024 || buf.length < 100) return bad(400, "bad image");
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return bad(400, "jpeg only");
    await store.set(
      `avatar/${userId}.bin`,
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
    const at = Date.now();
    if (prev) {
      prev.avatarAt = at;
      await store.setJSON(`traveler/${userId}.json`, prev);
    }
    return ok({ ok: true, avatarAt: at });
  }

  // ---- presence heartbeat: marks this browser as recently active ----
  if (action === "ping") {
    if (throttle(`ping:${ip}`, 90, 60 * 1000)) return ok({ ok: true });
    const c = await store.get(`traveler/${userId}.json`, { type: "json" }).catch(() => null);
    if (c && Date.now() - (c.seenAt || 0) > 30000) {
      c.seenAt = Date.now();
      await store.setJSON(`traveler/${userId}.json`, c);
    }
    return ok({ ok: true });
  }

  // ---- list live profiles (nearest first when viewer shares location) ----
  if (action === "travelers") {
    const now = Date.now();
    const vLat = Number(body.lat), vLng = Number(body.lng);
    const hasViewer = validCoords(vLat, vLng);
    const mine = await getBlocks(store, userId);
    const listed = await store.list({ prefix: "traveler/" }).catch(() => ({ blobs: [] }));
    const cards = [];
    for (const b of (listed.blobs || []).slice(0, 200)) {
      const c = await store.get(b.key, { type: "json" }).catch(() => null);
      if (!c || c.userId === userId) continue;
      if (now - (c.updatedAt || 0) > CARD_TTL_MS) continue;
      if (mine.includes(c.userId)) continue;
      if (c.openTo && !c.openTo.travelers && !c.openTo.friends) continue;
      const pub = publicCard(c);
      if (hasViewer && validCoords(c.lat, c.lng)) {
        pub.distanceKm = Math.round(haversineKm(vLat, vLng, c.lat, c.lng) * 10) / 10;
      }
      cards.push(pub);
    }
    if (hasViewer) {
      cards.sort((a, b) => (a.distanceKm == null ? 1e9 : a.distanceKm) - (b.distanceKm == null ? 1e9 : b.distanceKm));
    }
    return ok({ ok: true, travelers: cards.slice(0, 50) });
  }

  // ---- get-or-create thread ----
  if (action === "thread") {
    const otherId = String(body.otherId || "");
    if (!UID_RE.test(otherId) || otherId === userId) return bad(400, "bad peer");
    const [me, other] = await Promise.all([getCard(store, userId), getCard(store, otherId)]);
    if (!other) return bad(404, "traveler gone");
    if (await blockedEither(store, userId, otherId)) return bad(403, "unavailable");
    const tid = threadIdFor(userId, otherId);
    const metaKey = `thread/${tid}.json`;
    const existing = await store.get(metaKey, { type: "json" }).catch(() => null);
    if (!existing) {
      await store.setJSON(metaKey, { threadId: tid, a: userId, b: otherId, createdAt: Date.now(), updatedAt: Date.now() });
      for (const uid of [userId, otherId]) {
        const idx = (await store.get(`user-threads/${uid}.json`, { type: "json" }).catch(() => null)) || [];
        if (!idx.includes(tid)) {
          idx.push(tid);
          await store.setJSON(`user-threads/${uid}.json`, idx.slice(-50));
        }
      }
    }
    return ok({ ok: true, threadId: tid, other: publicCard(other), me: publicCard(me) });
  }

  // ---- my threads with preview ----
  if (action === "threads") {
    const idx = (await store.get(`user-threads/${userId}.json`, { type: "json" }).catch(() => null)) || [];
    const mine = await getBlocks(store, userId);
    const out = [];
    for (const tid of idx.slice(-20).reverse()) {
      const meta = await store.get(`thread/${tid}.json`, { type: "json" }).catch(() => null);
      if (!meta) continue;
      const otherId = meta.a === userId ? meta.b : meta.a;
      if (mine.includes(otherId)) continue;
      const other = await getCard(store, otherId);
      const listed = await store.list({ prefix: `msg/${tid}/` }).catch(() => ({ blobs: [] }));
      let last = null;
      for (const b of (listed.blobs || []).slice(-30)) {
        const m = await store.get(b.key, { type: "json" }).catch(() => null);
        if (m && (!last || m.at > last.at)) last = m;
      }
      out.push({
        threadId: tid,
        other: publicCard(other) || { userId: otherId, name: "Traveler", kind: "traveler", tag: "", note: "" },
        lastText: last ? String(last.text).slice(0, 80) : "",
        lastAt: last ? last.at : meta.updatedAt,
        lastFrom: last ? last.from : null,
      });
    }
    return ok({ ok: true, threads: out });
  }

  // ---- poll messages ----
  if (action === "messages") {
    const threadId = String(body.threadId || "");
    const since = Number(body.since || 0);
    if (!/^[a-f0-9]{32}$/.test(threadId)) return bad(400, "bad thread");
    const meta = await store.get(`thread/${threadId}.json`, { type: "json" }).catch(() => null);
    if (!meta || (meta.a !== userId && meta.b !== userId)) return bad(403, "no access");
    const listed = await store.list({ prefix: `msg/${threadId}/` }).catch(() => ({ blobs: [] }));
    const msgs = [];
    for (const b of (listed.blobs || []).slice(-100)) {
      const m = await store.get(b.key, { type: "json" }).catch(() => null);
      if (m && m.at > since) msgs.push({ from: m.from, text: m.text, at: m.at });
    }
    msgs.sort((x, y) => x.at - y.at);
    return ok({ ok: true, messages: msgs.slice(-100) });
  }

  // ---- send a message ----
  if (action === "send") {
    if (throttle(`send:${ip}`, 30, 60 * 1000)) return bad(429, "slow down");
    const threadId = String(body.threadId || "");
    const text = String(body.text || "").trim().slice(0, 500);
    if (!/^[a-f0-9]{32}$/.test(threadId)) return bad(400, "bad thread");
    if (!text) return bad(400, "empty message");
    const meta = await store.get(`thread/${threadId}.json`, { type: "json" }).catch(() => null);
    if (!meta || (meta.a !== userId && meta.b !== userId)) return bad(403, "no access");
    const otherId = meta.a === userId ? meta.b : meta.a;
    if (await blockedEither(store, userId, otherId)) return bad(403, "unavailable");
    const at = Date.now();
    const key = `msg/${threadId}/${at}-${crypto.randomBytes(4).toString("hex")}.json`;
    await store.setJSON(key, { threadId, from: userId, text, at });
    meta.updatedAt = at;
    await store.setJSON(`thread/${threadId}.json`, meta);
    return ok({ ok: true, at });
  }

  // ---- block ----
  if (action === "block") {
    const blockedId = String(body.blockedId || "");
    if (!UID_RE.test(blockedId) || blockedId === userId) return bad(400, "bad user");
    const list = await getBlocks(store, userId);
    if (!list.includes(blockedId)) {
      list.push(blockedId);
      await store.setJSON(`blocks/${userId}.json`, list.slice(-200));
    }
    return ok({ ok: true });
  }

  // ---- report (stores report + auto-blocks) ----
  if (action === "report") {
    if (throttle(`rep:${ip}`, 10, 10 * 60 * 1000)) return bad(429, "slow down");
    const reportedId = String(body.reportedId || "");
    const reason = String(body.reason || "");
    if (!UID_RE.test(reportedId) || reportedId === userId) return bad(400, "bad user");
    if (!REASONS.includes(reason)) return bad(400, "bad reason");
    const at = Date.now();
    await store.setJSON(`report/${at}-${crypto.randomBytes(4).toString("hex")}.json`, {
      reporter: userId,
      reported: reportedId,
      reason,
      at,
    });
    const list = await getBlocks(store, userId);
    if (!list.includes(reportedId)) {
      list.push(reportedId);
      await store.setJSON(`blocks/${userId}.json`, list.slice(-200));
    }
    return ok({ ok: true });
  }

  return bad(400, "unknown action");
};
