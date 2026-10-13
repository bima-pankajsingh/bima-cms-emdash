import { getEmDashCollection } from "emdash";

/** URL segment -> the `country_partner` value documents are stored under. */
export const MARKETS: Record<string, string> = {
	pk: "PAKISTAN_SIMPAISA",
};

/** URL segment -> `document_type`. These URLs are what the app's config points at: never rename one. */
export const DOCUMENTS: Record<string, { type: string; label: Record<Locale, string> }> = {
	terms: { type: "TERMS_OF_USE", label: { en: "Terms of Use", ur: "استعمال کی شرائط" } },
	privacy: { type: "PRIVACY_POLICY", label: { en: "Privacy Policy", ur: "رازداری کی پالیسی" } },
	about: { type: "ABOUT_US", label: { en: "About Us", ur: "ہمارے بارے میں" } },
};

export type Locale = "en" | "ur";

export interface LegalPage {
	entry: any;
	/** The locale the content is actually in - English when the requested one has no translation. */
	locale: Locale;
	fellBack: boolean;
	cacheHints: unknown[];
}

async function latest(type: string, partner: string, locale: Locale) {
	const { entries, cacheHint } = await getEmDashCollection("legal_documents", {
		status: "published",
		locale,
		where: { document_type: type, country_partner: partner },
		orderBy: { effective_from: "desc" },
		limit: 1,
	});
	return { entry: entries[0], cacheHint };
}

/**
 * The newest published document of a type for a market. A member must always be able to read
 * what they are asked to accept, so a missing translation falls back to English rather than 404.
 */
export async function findLegalPage(market: string, doc: string, locale: Locale): Promise<LegalPage | null> {
	const partner = MARKETS[market];
	const spec = DOCUMENTS[doc];
	if (!partner || !spec) return null;
	const first = await latest(spec.type, partner, locale);
	if (first.entry) return { entry: first.entry, locale, fellBack: false, cacheHints: [first.cacheHint] };
	if (locale === "en") return null;
	const en = await latest(spec.type, partner, "en");
	if (!en.entry) return null;
	return { entry: en.entry, locale: "en", fellBack: true, cacheHints: [first.cacheHint, en.cacheHint] };
}

/** A version string that says it is a draft is shown with the draft banner. */
export function isDraft(version: unknown): boolean {
	return typeof version === "string" && /draft/i.test(version);
}

/** Staging and preview hosts must not be indexed: they carry unapproved wording. */
export function isProductionHost(url: URL): boolean {
	return url.hostname === "cdn-pk.milvik.app";
}
