// username-router (edge): only real profile usernames resolve.
//
// The old /:username -> /index.html catch-all made EVERY bogus URL return
// HTTP 200 (a soft-404 farm that confuses Google). This checks the username
// against the meet.js username index in Blobs:
//   - real username -> internal rewrite to /index.html (200, URL unchanged;
//     the app resolves the profile from location.pathname, same as before)
//   - anything else  -> branded 404 page with noindex
// Real static files (sitemap.xml, og-share.png, ...) pass through untouched.
//
// meet.js keeps the index fresh: register writes usernames/<slug>.json,
// remove deletes it.

import { getStore } from "@netlify/blobs";

const SLUG_RE = /^[a-z0-9]{1,24}$/;
// page URLs served by the SPA — never treated as usernames
const PAGE_SLUGS = new Set(["events", "deals", "chat", "profile"]);

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

function notFound() {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

export default async (req, context) => {
  const seg = new URL(req.url).pathname.replace(/^\/+|\/+$/g, "");
  // real files (anything with a dot) pass through to static hosting
  if (!seg || seg.includes(".") || seg.includes("/")) return context.next();
  const slug = seg.toLowerCase();
  if (PAGE_SLUGS.has(slug)) return context.rewrite(new URL("/index.html", req.url));
  if (!SLUG_RE.test(slug)) return notFound();
  try {
    const store = getStore({
      name: "souvs-meet",
      siteID: Netlify.env.get("NETLIFY_SITE_ID"),
      token: Netlify.env.get("NETLIFY_BLOBS_TOKEN"),
    });
    const hit = await store.get(`usernames/${slug}.json`, { type: "json" });
    if (hit) return context.rewrite(new URL("/index.html", req.url));
  } catch (e) {
    // storage hiccup: fail closed (404) rather than serve the wrong status
  }
  return notFound();
};
