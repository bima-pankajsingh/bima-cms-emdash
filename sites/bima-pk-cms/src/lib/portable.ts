/**
 * Renders a legal document's Portable Text body to HTML, with an id on every section heading
 * so the page can carry a contents list and each section can be linked to.
 *
 * EmDash's own <PortableText> renders the same blocks but gives headings no ids. The document
 * set is small and fixed (paragraphs, headings, quotes, nested lists, a few marks, links), so
 * this covers it directly. Every piece of text is escaped; only http(s), mailto, tel, relative
 * and in-page links are emitted.
 */

export interface TocItem {
	id: string;
	text: string;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
const SAFE_HREF = /^(https?:|mailto:|tel:|\/|#)/i;

function slug(text: string, used: Set<string>, index: number): string {
	const base =
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\w\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, 60) || `section-${index + 1}`;
	let id = base;
	for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
	used.add(id);
	return id;
}

function plain(block: any): string {
	return (block.children ?? []).map((c: any) => c.text ?? "").join("");
}

function inline(block: any): string {
	const links = new Map<string, string>();
	for (const def of block.markDefs ?? []) {
		if (def?._type === "link" && typeof def.href === "string" && SAFE_HREF.test(def.href)) {
			links.set(def._key, def.href);
		}
	}
	let out = "";
	for (const span of block.children ?? []) {
		const text: string = span?.text ?? "";
		if (!text) continue;
		// Counsel's open items read as a flag, not as body copy that happens to be bold.
		let html = esc(text)
			.replace(/\[LEGAL\]/g, '<span class="legal-flag">[LEGAL]</span>')
			.replace(/\n/g, "<br>");
		const marks: string[] = span.marks ?? [];
		if (marks.includes("code")) html = `<code>${html}</code>`;
		if (marks.includes("strike-through")) html = `<s>${html}</s>`;
		if (marks.includes("underline")) html = `<u>${html}</u>`;
		if (marks.includes("em")) html = `<em>${html}</em>`;
		if (marks.includes("strong")) html = `<strong>${html}</strong>`;
		const href = marks.map((m) => links.get(m)).find(Boolean);
		if (href) {
			const external = /^https?:/i.test(href);
			html = `<a href="${esc(href)}"${external ? ' rel="noopener" target="_blank"' : ""}>${html}</a>`;
		}
		out += html;
	}
	return out;
}

export function renderBody(blocks: unknown): { html: string; toc: TocItem[] } {
	if (!Array.isArray(blocks)) return { html: "", toc: [] };
	const used = new Set<string>();
	const toc: TocItem[] = [];
	const lists: { tag: "ul" | "ol"; level: number }[] = [];
	let html = "";
	let headings = 0;

	const closeLists = () => {
		while (lists.length) html += `</li></${lists.pop()!.tag}>`;
	};

	for (const block of blocks as any[]) {
		if (block?._type !== "block") continue;
		const content = inline(block);
		if (block.listItem) {
			const tag = block.listItem === "number" ? "ol" : "ul";
			const level = Math.max(1, Number(block.level) || 1);
			while (lists.length && lists[lists.length - 1].level > level) html += `</li></${lists.pop()!.tag}>`;
			const top = lists[lists.length - 1];
			if (top && top.level === level) {
				if (top.tag === tag) html += "</li>";
				else html += `</li></${lists.pop()!.tag}>`;
			}
			const now = lists[lists.length - 1];
			if (!now || now.level < level) {
				html += `<${tag}>`;
				lists.push({ tag, level });
			}
			html += `<li>${content}`;
			continue;
		}
		closeLists();
		if (!content) continue;
		const style: string = block.style ?? "normal";
		if (style === "h1" || style === "h2") {
			const text = plain(block);
			const id = slug(text, used, headings++);
			toc.push({ id, text });
			html += `<h2 id="${id}"><a class="anchor" href="#${id}">${content}</a></h2>`;
		} else if (style === "h3") {
			const id = slug(plain(block), used, headings++);
			html += `<h3 id="${id}">${content}</h3>`;
		} else if (/^h[4-6]$/.test(style)) {
			html += `<h4>${content}</h4>`;
		} else if (style === "blockquote") {
			html += `<blockquote><p>${content}</p></blockquote>`;
		} else {
			html += `<p>${content}</p>`;
		}
	}
	closeLists();
	return { html, toc };
}
