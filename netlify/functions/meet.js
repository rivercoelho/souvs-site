// netlify/functions/meet.js
// Souvs traveler-to-traveler chat backend (simple polling, no accounts).
// POST { action, ... } -> JSON. Identity is a client-generated userId
// stored in the visitor's own browser. Storage: Netlify Blobs ("souvs-meet").
//
// Actions:
//   register  { userId, name, kind, tag, note }      -> upsert traveler card
//   travelers { userId }                             -> list live cards
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
const NAME_RE = /^[A-Za-z0-9 _.'-]{1,40}$/;
const CARD_TTL_MS = 14 * 24 * 3600 * 1000;

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
  c ? { userId: c.userId, name: c.name, kind: c.kind, tag: c.tag, note: c.note } : null;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
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

  let store;
  try {
    store = getStore({ name: "souvs-meet" });
  } catch {
    return bad(500, "storage unavailable");
  }

  // ---- register / update traveler card ----
  if (action === "register") {
    if (throttle(`reg:${ip}`, 5, 10 * 60 * 1000)) return bad(429, "slow down");
    const name = String(body.name || "").trim();
    const kind = String(body.kind || "");
    const tag = String(body.tag || "");
    const note = String(body.note || "").trim().slice(0, 140);
    if (!NAME_RE.test(name)) return bad(400, "bad name");
    if (!KINDS.includes(kind)) return bad(400, "bad kind");
    if (!TAGS.includes(tag)) return bad(400, "bad tag");
    const card = { userId, name, kind, tag, note, updatedAt: Date.now() };
    await store.setJSON(`traveler/${userId}.json`, card);
    return ok({ ok: true, card: publicCard(card) });
  }

  // ---- list live traveler cards ----
  if (action === "travelers") {
    const now = Date.now();
    const mine = await getBlocks(store, userId);
    const listed = await store.list({ prefix: "traveler/" }).catch(() => ({ blobs: [] }));
    const cards = [];
    for (const b of (listed.blobs || []).slice(0, 200)) {
      const c = await store.get(b.key, { type: "json" }).catch(() => null);
      if (!c || c.userId === userId) continue;
      if (now - (c.updatedAt || 0) > CARD_TTL_MS) continue;
      if (mine.includes(c.userId)) continue;
      cards.push(publicCard(c));
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
