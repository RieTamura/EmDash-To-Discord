/**
 * Builds the Discord webhook message and checks webhook URLs.
 * Pure functions, no plugin context.
 */

/** Discord's limits, in characters. */
export const LIMITS = { content: 2000, title: 256, description: 4096 } as const;

export const DEFAULTS = {
	content: "",
	title: "{title}",
	description: "{excerpt}",
} as const;

export interface Templates {
	content: string;
	title: string;
	description: string;
}

export interface MessageFields {
	title: string;
	url: string;
	excerpt?: string;
	collection: string;
	/** ISO date-time the entry was published. */
	publishedAt?: string | null;
	/** IANA time zone for {date}, e.g. "Asia/Tokyo". Unknown zones fall back to UTC. */
	timeZone?: string;
	/** Public URL of the featured image. */
	imageUrl?: string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts text to `max` UTF-16 units with a trailing "…", never splitting a
 * character. UTF-16 length is never shorter than Discord's count, so the
 * result always fits.
 */
export function shorten(text: string, max: number): string {
	if (text.length <= max) return text;
	let out = "";
	for (const { segment } of segmenter.segment(text)) {
		if (out.length + segment.length > max - 1) break;
		out += segment;
	}
	return `${out.trimEnd()}…`;
}

/** "YYYY-MM-DD" in the given time zone, or UTC when the zone is unknown. */
export function formatDate(iso: string | null | undefined, timeZone = "UTC"): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const format = (zone: string) =>
		new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	try {
		return format(timeZone || "UTC");
	} catch {
		return format("UTC");
	}
}

/**
 * Fills {title}, {url}, {excerpt}, {date} and {collection} in one pass, so a
 * title that contains "{url}" stays plain text. Unknown names stay as they are.
 */
export function fill(template: string, fields: MessageFields): string {
	const values: Record<string, string> = {
		title: fields.title,
		url: fields.url,
		excerpt: fields.excerpt ?? "",
		date: formatDate(fields.publishedAt, fields.timeZone),
		collection: fields.collection,
	};
	return template.replace(/\{(title|url|excerpt|date|collection)\}/g, (_match, key: string) => values[key]!).trim();
}

export function buildMessage(templates: Templates, fields: MessageFields) {
	const title = fill(templates.title, fields) || fill(DEFAULTS.title, fields);
	const description = fill(templates.description, fields);
	const content = fill(templates.content, fields);
	const timestamp = fields.publishedAt && !Number.isNaN(Date.parse(fields.publishedAt))
		? new Date(fields.publishedAt).toISOString()
		: undefined;
	return {
		content: shorten(content, LIMITS.content),
		embeds: [
			{
				title: shorten(title, LIMITS.title),
				url: fields.url,
				...(description ? { description: shorten(description, LIMITS.description) } : {}),
				...(fields.imageUrl ? { image: { url: fields.imageUrl } } : {}),
				...(timestamp ? { timestamp } : {}),
			},
		],
		// Nobody is notified, even by "@everyone" in a title.
		allowed_mentions: { parse: [] as string[] },
	};
}

/** Hosts Discord serves webhooks from. All are sent to discord.com, the only allowed host. */
const WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

export interface Webhook {
	id: string;
	token: string;
}

/** Reads a webhook URL as copied from Discord. Anything else gives undefined. */
export function parseWebhookUrl(value: string | undefined): Webhook | undefined {
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || !WEBHOOK_HOSTS.has(url.hostname)) return undefined;
	const match = url.pathname.match(/^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/);
	return match ? { id: match[1]!, token: match[2]! } : undefined;
}

export function webhookEndpoint(webhook: Webhook): string {
	return `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
}

/** Where the site serves an uploaded file without signing in. */
export function featuredImageUrl(image: unknown, pageUrl: string): string | undefined {
	if (!image || typeof image !== "object") return undefined;
	const value = image as { src?: unknown; meta?: { storageKey?: unknown } | null };
	if (typeof value.src === "string" && /^https?:\/\//.test(value.src)) return value.src;
	const key = value.meta?.storageKey;
	if (typeof key !== "string" || !key) return undefined;
	return `${new URL(pageUrl).origin}/_emdash/api/media/file/${encodeURIComponent(key)}`;
}

export function messageLink(guildId: string | undefined, channelId: string | undefined, messageId: string | undefined) {
	return guildId && channelId && messageId
		? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
		: undefined;
}
