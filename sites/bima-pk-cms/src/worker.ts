import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

/**
 * The public document pages, rendered once and served from Cloudflare's cache.
 *
 * Each uncached render queries D1, which runs in one region with the Worker often in another,
 * so a cold page costs seconds; a cached one costs the trip to the nearest Cloudflare location.
 * The cost is freshness: a newly published edit can take up to EDGE_TTL to appear. That suits
 * legal text, whose wording changes are coordinated with the app's notice version anyway.
 *
 * Only these routes, only anonymous GETs, only 200s without a cookie. Admin, API, setup and
 * preview traffic never passes through here, and a signed-in editor (who carries a cookie)
 * always sees the live render.
 */
const CACHEABLE = /^\/(?:ur\/)?pk\/[a-z-]+\/?$|^\/$/;
const EDGE_TTL = 600; // seconds a page lives in Cloudflare's cache
const BROWSER_TTL = 300; // seconds a browser or webview may reuse it without asking

/**
 * The cache key keeps only the query parameter that changes the page (app=1), so a tracking
 * parameter or a cache-busting one cannot multiply copies or force a database round trip.
 */
function cacheKey(url: URL): Request {
	const key = new URL(url.origin + url.pathname);
	if (url.searchParams.get("app") === "1") key.searchParams.set("app", "1");
	return new Request(key.toString(), { method: "GET" });
}

export default {
	...handler,
	async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const eligible =
			request.method === "GET" &&
			CACHEABLE.test(url.pathname) &&
			!request.headers.has("cookie") &&
			!request.headers.has("authorization");
		if (!eligible) return handler.fetch!(request as any, env as any, ctx);

		const cache = caches.default;
		const key = cacheKey(url);
		const hit = await cache.match(key);
		if (hit) {
			const response = new Response(hit.body, hit);
			response.headers.set("Cache-Control", `public, max-age=${BROWSER_TTL}`);
			response.headers.set("X-Page-Cache", "HIT");
			return response;
		}

		const fresh = await handler.fetch!(request as any, env as any, ctx);
		if (fresh.status !== 200 || fresh.headers.has("set-cookie")) {
			const response = new Response(fresh.body, fresh);
			response.headers.set("X-Page-Cache", "BYPASS");
			return response;
		}
		const stored = new Response(fresh.clone().body, fresh);
		stored.headers.set("Cache-Control", `public, s-maxage=${EDGE_TTL}, max-age=${EDGE_TTL}`);
		stored.headers.delete("server-timing");
		ctx.waitUntil(cache.put(key, stored));

		const response = new Response(fresh.body, fresh);
		response.headers.set("Cache-Control", `public, max-age=${BROWSER_TTL}`);
		response.headers.set("X-Page-Cache", "MISS");
		return response;
	},
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
