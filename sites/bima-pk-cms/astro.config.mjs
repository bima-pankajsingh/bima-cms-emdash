import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { fileURLToPath } from "node:url";
import { graphEmail } from "./src/plugins/graph-email.ts";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	i18n: {
		defaultLocale: "en",
		locales: ["en", "ur"],
		fallback: { ur: "en" },
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			// Magic links, invites and recovery from no-reply@milvik.se via Microsoft Graph.
			// Credentials are Worker vars/secret - see src/plugins/graph-email.ts.
			plugins: [
				graphEmail(
					{ from: { email: "no-reply@milvik.se", name: "BIMA CMS" } },
					fileURLToPath(new URL("./src/plugins/graph-email.ts", import.meta.url)),
				),
			],
		}),
	],
	devToolbar: { enabled: false },
});
