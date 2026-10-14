/**
 * Minimal SMTP submission client over Cloudflare Workers TCP sockets (cloudflare:sockets).
 *
 * Just what EmDash's mail needs: EHLO, STARTTLS (port 587) or implicit TLS (465), AUTH LOGIN,
 * one message to one recipient plus Cc, QUIT. No dependencies - the community emdash-smtp
 * package failed vetting, and nodemailer is not Workers-native anyway. Workers cannot reach
 * port 25; submission ports only.
 */
import { connect } from "cloudflare:sockets";

export interface SmtpSettings { host: string; port: number; user: string; password: string }
export interface SmtpMail {
	from: { email: string; name?: string };
	to: string; cc?: string[]; replyTo?: string;
	subject: string; text: string; html?: string;
}

const enc = new TextEncoder();
const CRLF = "\r\n";

function b64(s: string): string {
	const bytes = enc.encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}
/** RFC 2047 encoded-word when the header is not plain ASCII. */
function header(value: string): string {
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}
function addr(email: string, name?: string): string {
	return name ? `${header(name)} <${email}>` : `<${email}>`;
}
/** Base64 body, wrapped at 76 characters as MIME requires. */
function body64(s: string): string {
	return (b64(s).match(/.{1,76}/g) ?? [""]).join(CRLF);
}
function noCrlf(s: string): string {
	if (/[\r\n]/.test(s)) throw new Error("[smtp] header value contains a line break");
	return s;
}

export function buildMessage(m: SmtpMail, now = new Date()): string {
	const boundary = `bima-${crypto.randomUUID()}`;
	const domain = m.from.email.split("@")[1] ?? "localhost";
	const head = [
		`From: ${addr(noCrlf(m.from.email), m.from.name)}`,
		`To: <${noCrlf(m.to)}>`,
		...(m.cc?.length ? [`Cc: ${m.cc.map((c) => `<${noCrlf(c)}>`).join(", ")}`] : []),
		...(m.replyTo ? [`Reply-To: <${noCrlf(m.replyTo)}>`] : []),
		`Subject: ${header(noCrlf(m.subject))}`,
		`Date: ${now.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${crypto.randomUUID()}@${domain}>`,
		"MIME-Version: 1.0",
	];
	const text = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body64(m.text)];
	if (!m.html) return [...head, ...text].join(CRLF);
	return [
		...head,
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`, ...text,
		`--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body64(m.html),
		`--${boundary}--`,
	].join(CRLF);
}

/** Reads SMTP replies line by line; a reply ends on "NNN " (multi-line replies use "NNN-"). */
class Conn {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private buffer = "";
	private dec = new TextDecoder();
	constructor(private socket: Socket) {
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
	}
	private async line(): Promise<string> {
		while (!this.buffer.includes("\n")) {
			const { value, done } = await this.reader.read();
			if (done) throw new Error("[smtp] connection closed by server");
			this.buffer += this.dec.decode(value, { stream: true });
		}
		const i = this.buffer.indexOf("\n");
		const l = this.buffer.slice(0, i).replace(/\r$/, "");
		this.buffer = this.buffer.slice(i + 1);
		return l;
	}
	async reply(expect: number, step: string): Promise<string> {
		// Each step gets its own limit, so a hang names the step rather than surfacing as the
		// hook's generic timeout.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`[smtp] ${step}: no reply within 10s`)), 10_000);
		});
		try {
			return await Promise.race([this.readReply(expect, step), limit]);
		} finally {
			clearTimeout(timer);
		}
	}
	private async readReply(expect: number, step: string): Promise<string> {
		let l = await this.line();
		const all = [l];
		while (/^\d{3}-/.test(l)) { l = await this.line(); all.push(l); }
		const code = Number(l.slice(0, 3));
		if (code !== expect) {
			// Code and text only: the server's text never contains our credentials.
			throw new Error(`[smtp] ${step}: expected ${expect}, got ${l.slice(0, 160)}`);
		}
		return all.join("\n");
	}
	async send(cmd: string): Promise<void> { await this.writer.write(enc.encode(cmd + CRLF)); }
	async sendRaw(data: string): Promise<void> { await this.writer.write(enc.encode(data)); }
	release(): Socket { this.reader.releaseLock(); this.writer.releaseLock(); return this.socket; }
	async close(): Promise<void> { try { await this.socket.close(); } catch { /* already closed */ } }
}

export async function sendSmtp(s: SmtpSettings, m: SmtpMail): Promise<void> {
	const implicitTls = s.port === 465;
	let socket = connect({ hostname: s.host, port: s.port }, { secureTransport: implicitTls ? "on" : "starttls", allowHalfOpen: false });
	let c = new Conn(socket);
	try {
		await c.reply(220, "greeting");
		await c.send("EHLO bima-pk-cms");
		let caps = await c.reply(250, "EHLO");
		if (!implicitTls) {
			if (!/STARTTLS/i.test(caps)) throw new Error("[smtp] server does not offer STARTTLS - refusing to send credentials in clear");
			await c.send("STARTTLS");
			await c.reply(220, "STARTTLS");
			socket = c.release().startTls();
			c = new Conn(socket);
			await c.send("EHLO bima-pk-cms");
			caps = await c.reply(250, "EHLO after TLS");
		}
		await c.send("AUTH LOGIN");
		await c.reply(334, "AUTH LOGIN");
		await c.send(b64(s.user));
		await c.reply(334, "AUTH username");
		await c.send(b64(s.password));
		await c.reply(235, "AUTH password");
		await c.send(`MAIL FROM:<${s.user}>`);
		await c.reply(250, "MAIL FROM");
		for (const rcpt of [m.to, ...(m.cc ?? [])]) {
			await c.send(`RCPT TO:<${noCrlf(rcpt)}>`);
			await c.reply(250, "RCPT TO");
		}
		await c.send("DATA");
		await c.reply(354, "DATA");
		// Dot-stuffing: a line that starts with "." gets a second one.
		const data = buildMessage(m).split(CRLF).map((l) => (l.startsWith(".") ? "." + l : l)).join(CRLF);
		await c.sendRaw(data + CRLF + "." + CRLF);
		await c.reply(250, "message accepted");
		await c.send("QUIT");
	} finally {
		await c.close();
	}
}
