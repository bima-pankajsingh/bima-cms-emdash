import { getEmDashCollection } from "emdash";
import { MARKETS, type LegalPage, type Locale } from "./legal";

/**
 * Product terms and conditions, one entry per product (and locale), linked from the member
 * policy document. Looked up by `terms_key` - a stable, non-translatable key the URL carries -
 * rather than by slug, because a translated entry may have its own slug.
 */
async function latest(key: string, partner: string, locale: Locale) {
	const { entries, cacheHint } = await getEmDashCollection("policy_terms", {
		status: "published",
		locale,
		where: { terms_key: key, country_partner: partner },
		orderBy: { effective_from: "desc" },
		limit: 1,
	});
	return { entry: entries[0], cacheHint };
}

/** The product's terms; a missing translation falls back to English, as the legal pages do. */
export async function findPolicyTermsPage(market: string, key: string, locale: Locale): Promise<LegalPage | null> {
	const partner = MARKETS[market];
	if (!partner || !/^[a-z0-9-]{1,64}$/.test(key)) return null;
	const first = await latest(key, partner, locale);
	if (first.entry) return { entry: first.entry, locale, fellBack: false, cacheHints: [first.cacheHint] };
	if (locale === "en") return null;
	const en = await latest(key, partner, "en");
	if (!en.entry) return null;
	return { entry: en.entry, locale: "en", fellBack: true, cacheHints: [first.cacheHint, en.cacheHint] };
}
