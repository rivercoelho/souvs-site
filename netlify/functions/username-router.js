// username-router: only real profile usernames resolve.
//
// The old /:username -> /index.html catch-all made EVERY bogus URL return
// HTTP 200 (a soft-404 farm that confuses Google). This function checks the
// username against the meet.js username index in Blobs:
//   - real username -> serve the SPA shell with 200 (the app resolves the
//     profile from location.pathname, same as before)
//   - anything else   -> branded 404 page with noindex
//
// meet.js keeps the index fresh: register writes usernames/<slug>.json,
// remove deletes it. ?action=rebuild backfills from existing cards (one-off).

const { getStore } = require("@netlify/blobs");

const SLUG_RE = /^[a-z0-9]{1,24}$/;
const SITE_URL = "https://souvs.shop";

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Not found — Souvs</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:sans-serif;color:#fff;text-align:center;
    background:linear-gradient(180deg,#1a143f 0%,#5b2a86 40%,#e86a92 70%,#ffb37a 100%);}
  .card{padding:2rem;}
  h1{font-size:4rem;margin:0 0 .5rem;text-shadow:0 3px 0 rgba(0,0,0,.25);}
  p{font-size:1.15rem;opacity:.95;margin:.25rem 0 1.5rem;}
  a{display:inline-block;background:#fff;color:#2b1a12;font-weight:700;
    padding:.8rem 1.8rem;border-radius:999px;text-decoration:none;}
</style></head>
<body><div class="card">
  <h1>Souvs</h1>
  <p>This page doesn't exist. The critters couldn't find it either.</p>
  <a href="https://souvs.shop/">Back to Souvs</a>
</div></body></html>`;

const openStore = () =>
  getStore({
    name: "souvs-meet",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });

const notFound = () => ({
  statusCode: 404,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  },
  body: NOT_FOUND_HTML,
});

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};

  // one-time backfill: rebuild usernames/<slug>.json from existing cards
  if (qs.action === "rebuild") {
    const store = openStore();
    const listed = await store.list({ prefix: "traveler/" }).catch(() => ({ blobs: [] }));
    let n = 0;
    const sample = [];
    for (const b of listed.blobs || []) {
      const c = await store.get(b.key, { type: "json" }).catch(() => null);
      if (c && c.username && SLUG_RE.test(c.username)) {
        await store.setJSON(`usernames/${c.username}.json`, { userId: c.userId || b.key });
        n++;
        if (sample.length < 10) sample.push(c.username);
      }
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rebuilt: n, sample }),
    };
  }

  const slug = String(qs.u || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return notFound();

  const hit = await openStore()
    .get(`usernames/${slug}.json`, { type: "json" })
    .catch(() => null);
  if (!hit) return notFound();

  // real username: serve the SPA shell; the app resolves the profile from the path
  const res = await fetch(SITE_URL + "/");
  const html = await res.text();
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: html,
  };
};
