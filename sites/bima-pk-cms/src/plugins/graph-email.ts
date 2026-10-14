/**
 * Microsoft Graph email provider for EmDash: magic links, invites and account recovery sent
 * from a Microsoft 365 mailbox (no-reply@milvik.se) with Graph `sendMail`, over HTTPS.
 *
 * Why our own: the community emdash-smtp package failed package vetting (15 advisories in its
 * bundled nodemailer), and its raw SMTP transport is doubtful on Workers anyway. This is the
 * same shape as EmDash's own cloudflare-email plugin, with plain fetch and no dependencies.
 *
 * Configuration, read from the Worker env at delivery time (never from import.meta.env, which
 * Vite would bake into the bundle):
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID      wrangler vars (identifiers, not secrets)
 *   GRAPH_CLIENT_SECRET                   wrangler secret (`wrangler secret put GRAPH_CLIENT_SECRET`)
 * The Entra app needs the application permission Mail.Send, admin-consented, and should be
 * scoped to the sending mailbox only (Exchange application access policy / RBAC for Apps) -
 * Mail.Send alone lets it send as any mailbox in the tenant.
 */
import { definePlugin } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";

export interface GraphEmailConfig {
	/** The mailbox Graph sends as. Must exist in the tenant (a shared mailbox is fine). */
	from: string | { email: string; name?: string };
	/** Where replies go; the no-reply mailbox is not read. A message's own replyTo wins. */
	replyTo?: string;
}

type Env = Record<string, unknown>;

async function loadEnv(): Promise<Env> {
	try {
		const { env } = await import("cloudflare:workers");
		return env as unknown as Env;
	} catch {
		throw new Error("[graph-email] cloudflare:workers is not available - this provider runs on the Workers runtime only.");
	}
}

function required(env: Env, name: string): string {
	const value = env[name];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`[graph-email] ${name} is not set on this Worker (see src/plugins/graph-email.ts).`);
	}
	return value.trim();
}

/** App-only token, reused until a minute before it expires. Per isolate, never persisted. */
let cached: { token: string; expiresAt: number; key: string } | null = null;

async function accessToken(tenant: string, clientId: string, secret: string): Promise<string> {
	const key = `${tenant}/${clientId}`;
	if (cached && cached.key === key && cached.expiresAt > Date.now() + 60_000) return cached.token;
	const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: secret,
			scope: "https://graph.microsoft.com/.default",
			grant_type: "client_credentials",
		}),
	});
	const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
	if (!response.ok || !body.access_token) {
		// The error code only (invalid_client, unauthorized_client ...) - never the response body,
		// which can echo request details.
		throw new Error(`[graph-email] token request failed: HTTP ${response.status} ${body.error ?? ""}`.trim());
	}
	cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, key };
	return body.access_token;
}

const address = (email: string) => ({ emailAddress: { address: email } });

/** @internal exported for tests */
export function createGraphEmailDeliver(config: GraphEmailConfig, getEnv: () => Promise<Env> = loadEnv) {
	const from = typeof config.from === "string" ? { email: config.from } : config.from;
	return async (event: EmailDeliverEvent, ctx: { log: { info: (m: string, d?: unknown) => void } }) => {
		const env = await getEnv();
		const token = await accessToken(required(env, "GRAPH_TENANT_ID"), required(env, "GRAPH_CLIENT_ID"),
			required(env, "GRAPH_CLIENT_SECRET"));
		const { message } = event;
		const replyTo = message.replyTo ?? config.replyTo;
		const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from.email)}/sendMail`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				message: {
					subject: message.subject,
					body: message.html ? { contentType: "HTML", content: message.html } : { contentType: "Text", content: message.text },
					from: { emailAddress: { address: from.email, ...(from.name ? { name: from.name } : {}) } },
					toRecipients: [address(message.to)],
					...(message.cc?.length ? { ccRecipients: message.cc.map(address) } : {}),
					...(replyTo ? { replyTo: [address(replyTo)] } : {}),
				},
				// The no-reply mailbox is not read; a Sent Items copy of every magic link would be a
				// pile of live sign-in links in a mailbox nobody watches.
				saveToSentItems: false,
			}),
		});
		if (response.status !== 202) {
			const err = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
			if (response.status === 401) cached = null;
			throw new Error(`[graph-email] sendMail failed: HTTP ${response.status} ${err.error?.code ?? ""}`.trim());
		}
		// Recipient and subject only; never the body (it carries the magic link).
		ctx.log.info("email delivered via Microsoft Graph", { to: message.to, subject: message.subject });
	};
}

function assertFrom(config: GraphEmailConfig) {
	const email = typeof config.from === "string" ? config.from : config.from?.email;
	if (!email || !email.includes("@")) throw new Error('[graph-email] config.from is required, e.g. { from: "no-reply@milvik.se" }');
}

/** Called by the generated virtual:emdash/plugins module with the descriptor's options. */
export function createPlugin(config: GraphEmailConfig) {
	assertFrom(config);
	return definePlugin({
		id: "microsoft-graph-email",
		version: "1.0.0",
		capabilities: ["hooks.email-transport:register"],
		hooks: { "email:deliver": { exclusive: true, handler: createGraphEmailDeliver(config) } },
	});
}

/**
 * The descriptor for emdash({ plugins: [...] }). The entrypoint is this file's absolute path:
 * the integration writes it into an import statement, so a project-relative path would not
 * resolve.
 */
export function graphEmail(config: GraphEmailConfig, entrypoint: string) {
	assertFrom(config);
	return {
		id: "microsoft-graph-email",
		version: "1.0.0",
		entrypoint,
		format: "native" as const,
		options: config,
		capabilities: ["hooks.email-transport:register"],
	};
}
