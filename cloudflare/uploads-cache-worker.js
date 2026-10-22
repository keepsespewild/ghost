// Cloudflare Worker for sespewild.org/content/files/* and /content/images/*.
//
// The site is orange-to-orange: sespewild.org's zone proxies to Render, which is
// itself on Cloudflare, so zone cache rules never cache these uploads and every
// download is billed as Render bandwidth. This Worker stores uploads in
// Cloudflare's per-data-center cache with the Cache API and serves repeats
// from there. Ghost already sends `cache-control: public, max-age=31536000`.
//
// Responses carry `x-ksw-cache: HIT|MISS|PASS` for checking.

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fetch(request);
    }

    // Ignore query strings so cache-busting crawlers share one cached copy.
    const url = new URL(request.url);
    url.search = "";
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cache = caches.default;

    // match() honours a Range header, so PDF viewers get 206s from cache.
    const range = request.headers.get("range");
    const lookup = range
      ? new Request(cacheKey, { headers: { range } })
      : cacheKey;
    const cached = await cache.match(lookup);
    if (cached) {
      return tag(cached, "HIT", request.method);
    }

    // Miss: fetch the whole file once so the cached copy is complete.
    // redirect: "manual" so a redirect is passed through, never cached as a file.
    const origin = await fetch(url.toString(), {
      headers: { "user-agent": request.headers.get("user-agent") || "" },
      redirect: "manual",
    });
    if (origin.status !== 200 || !isCacheable(origin)) {
      return tag(origin, "PASS", request.method);
    }

    ctx.waitUntil(cache.put(cacheKey, origin.clone()));

    if (range) {
      // Serve the requested range from the origin; later requests hit cache.
      return tag(await fetch(request), "MISS", request.method);
    }
    return tag(origin, "MISS", request.method);
  },
};

function isCacheable(response) {
  const cc = response.headers.get("cache-control") || "";
  return !/no-store|private/i.test(cc) && !response.headers.has("set-cookie");
}

function tag(response, status, method) {
  const out = new Response(method === "HEAD" ? null : response.body, response);
  out.headers.set("x-ksw-cache", status);
  return out;
}
