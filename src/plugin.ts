import type { StorageCollection } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import {
	buildMessage,
	DEFAULTS,
	featuredImageUrl,
	messageLink,
	parseWebhookUrl,
	webhookEndpoint,
	type Templates,
	type Webhook,
} from "./message";

/**
 * Posts a card to a Discord channel the first time an entry is published.
 *
 * It posts at most once per entry. The record is claimed before anything is
 * sent, so a crash can leave a post unsent (shown in the admin, with a button
 * to send it) but can never send it twice by itself.
 *
 * A sandbox allows 10 subrequests per run, and every storage, settings, content
 * and kv call counts as well as every fetch. A publish makes at most 7:
 * settings, kv, claim, public URL, webhook, webhook info (only when Discord
 * leaves out the server ID), record. A resend from the admin makes at most 8.
 * Count again before adding a call.
 */

type ShareStatus = "pending" | "shared" | "failed" | "skipped";

/** One record per entry, keyed "<collection>:<translation group or id>". */
interface ShareRecord {
	collection: string;
	id: string;
	title: string;
	status: ShareStatus;
	/** Discord's IDs of the message, to link to it from the admin. */
	messageId?: string;
	channelId?: string;
	guildId?: string;
	/** Why the post failed or was not sent. Never holds the webhook URL. */
	note?: string;
	updatedAt: string;
}

interface Entry {
	id: string;
	slug?: string | null;
	status?: string;
	publishedAt?: string | null;
	translationGroup?: string | null;
	data?: Record<string, unknown>;
}

interface Settings {
	webhookUrl?: string;
	collections: string;
	templates: Templates;
	includeImage: boolean;
	timeZone: string;
	/** Why the settings could not be read, such as a missing encryption key. */
	readError?: string;
}

const DEFAULT_COLLECTIONS = "posts";
const SINCE_KEY = "state:since";
const ADMIN_LIMIT = 50;
/** A Worker's after-response work ends at 30 s. Stop before that. */
const HOOK_TIMEOUT = 25_000;

function sharesOf(ctx: PluginContext) {
	return ctx.storage.shares as StorageCollection<ShareRecord>;
}

function shareKey(collection: string, entry: Entry) {
	return `${collection}:${entry.translationGroup || entry.id}`;
}

function titleOf(entry: Entry) {
	const title = entry.data?.title;
	return typeof title === "string" && title ? title : (entry.slug ?? entry.id);
}

/** All settings in one call, to stay within the subrequest limit. */
async function readSettings(ctx: PluginContext): Promise<Settings> {
	const defaults: Settings = {
		collections: DEFAULT_COLLECTIONS,
		templates: { ...DEFAULTS },
		includeImage: true,
		timeZone: "UTC",
	};
	try {
		const values = new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
		const text = (key: string) => {
			const value = values.get(key);
			return typeof value === "string" ? value : undefined;
		};
		const includeImage = values.get("includeImage");
		return {
			webhookUrl: text("webhookUrl")?.trim(),
			collections: text("collections") ?? DEFAULT_COLLECTIONS,
			templates: {
				content: text("content") ?? DEFAULTS.content,
				title: text("embedTitle") ?? DEFAULTS.title,
				description: text("embedDescription") ?? DEFAULTS.description,
			},
			includeImage: typeof includeImage === "boolean" ? includeImage : true,
			timeZone: text("timeZone")?.trim() || "UTC",
		};
	} catch (error) {
		return {
			...defaults,
			readError: `The settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function isCollectionAllowed(settings: Settings, collection: string) {
	return settings.collections
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.includes(collection.toLowerCase());
}

/** Takes the webhook token out of any text that might be logged or stored. */
function redact(text: string, webhook: Webhook | undefined) {
	return webhook ? text.split(webhook.token).join("***") : text;
}

/** Only Discord's message and the status: never the request. */
async function apiError(step: string, response: Response) {
	let detail = "";
	try {
		const body = (await response.json()) as { message?: unknown; retry_after?: unknown };
		if (typeof body.message === "string") detail = body.message;
		if (response.status === 429 && typeof body.retry_after === "number") {
			detail += ` (retry after ${Math.ceil(body.retry_after)} s / ${Math.ceil(body.retry_after)} 秒後に再送してください)`;
		}
	} catch {
		// Not JSON: the status is all there is.
	}
	return new Error(`${step}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
}

interface DiscordMessage {
	id?: string;
	channel_id?: string;
	guild_id?: string;
}

/** Sends the message and returns Discord's IDs for it. Throws on failure. */
async function send(ctx: PluginContext, collection: string, entry: Entry, webhook: Webhook, settings: Settings) {
	const url = await ctx.content!.getPublicUrl!(collection, entry.id);
	if (!url) throw new Error("The entry has no public URL. / 記事の公開 URL がありません。");
	const excerpt = entry.data?.excerpt;
	const body = buildMessage(settings.templates, {
		title: titleOf(entry),
		url,
		excerpt: typeof excerpt === "string" ? excerpt : undefined,
		collection,
		publishedAt: entry.publishedAt,
		timeZone: settings.timeZone,
		imageUrl: settings.includeImage ? featuredImageUrl(entry.data?.featured_image, url) : undefined,
	});
	const endpoint = webhookEndpoint(webhook);
	const response = await ctx.http!.fetch(`${endpoint}?wait=true`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw await apiError("Discord", response);
	const message = (await response.json()) as DiscordMessage;
	let guildId = message.guild_id;
	if (!guildId) {
		// The link to the message needs the server ID. It is only for the admin
		// page, so a failure here must not mark the post as failed.
		try {
			const info = await ctx.http!.fetch(endpoint);
			if (info.ok) guildId = ((await info.json()) as { guild_id?: string }).guild_id;
		} catch {
			// No link then.
		}
	}
	return { messageId: message.id, channelId: message.channel_id, guildId };
}

/** Sends a claimed record and saves how it went. Never throws: publishing must not depend on this. */
async function sendAndRecord(
	ctx: PluginContext,
	key: string,
	collection: string,
	entry: Entry,
	settings: Settings,
): Promise<ShareRecord> {
	const base = { collection, id: entry.id, title: titleOf(entry) };
	const now = () => new Date().toISOString();
	const webhook = parseWebhookUrl(settings.webhookUrl);
	let record: ShareRecord;
	try {
		if (settings.readError) throw new Error(settings.readError);
		if (!settings.webhookUrl) {
			record = {
				...base,
				status: "skipped",
				note: "The webhook URL is not set. / Webhook の URL が未設定です。",
				updatedAt: now(),
			};
		} else if (!webhook) {
			record = {
				...base,
				status: "skipped",
				note: "The webhook URL is not a Discord webhook URL (https://discord.com/api/webhooks/…). / Webhook の URL が Discord のものではありません（https://discord.com/api/webhooks/…）。",
				updatedAt: now(),
			};
		} else {
			const ids = await send(ctx, collection, entry, webhook, settings);
			record = { ...base, status: "shared", ...ids, updatedAt: now() };
		}
	} catch (error) {
		const note = redact(error instanceof Error ? error.message : String(error), webhook);
		ctx.log.error(`discord-share: could not post ${collection}/${entry.id}: ${note}`);
		record = { ...base, status: "failed", note, updatedAt: now() };
	}
	await sharesOf(ctx).put(key, record);
	return record;
}

async function shareOnPublish(ctx: PluginContext, collection: string, entry: Entry) {
	if (entry.status !== "published") return;
	const settings = await readSettings(ctx);
	if (!isCollectionAllowed(settings, collection)) return;

	// Republishing keeps publishedAt, so an entry from before the plugin was
	// installed is still old when it is edited and republished.
	const since = await ctx.kv.get<string>(SINCE_KEY);
	if (!since || !entry.publishedAt || Date.parse(entry.publishedAt) < Date.parse(since)) return;

	const key = shareKey(collection, entry);
	const claim = await sharesOf(ctx).compareAndSet(key, null, {
		collection,
		id: entry.id,
		title: titleOf(entry),
		status: "pending",
		updatedAt: new Date().toISOString(),
	});
	if (!claim.applied) return;
	await sendAndRecord(ctx, key, collection, entry, settings);
}

/** The start line for "new". Kept when the plugin is switched off and on again. */
async function markStart(ctx: PluginContext) {
	await ctx.kv.compareAndSet(SINCE_KEY, null, new Date().toISOString());
}

// ── Admin page ──────────────────────────────────────────────────

const STATUS_LABEL: Record<ShareStatus, string> = {
	pending: "Interrupted? / 中断の可能性",
	shared: "Posted / 投稿済み",
	failed: "Failed / 失敗",
	skipped: "Not sent / 未送信",
};

async function sharesPage(
	ctx: PluginContext,
	toast?: { type: "success" | "error"; message: string },
	/** Rows to show without reading them again, when a run has used up its subrequests. */
	known?: Array<{ id: string; data: ShareRecord }>,
) {
	const items =
		known ?? (await sharesOf(ctx).query({ orderBy: { updatedAt: "desc" }, limit: ADMIN_LIMIT })).items;
	return {
		blocks: [
			{ type: "header", text: "Discord Share" },
			{
				type: "context",
				text: "New entries are posted once, when first published. Before sending an “Interrupted?” row, check Discord: it may have arrived already. / 新しい記事を、最初の公開時に 1 回だけ投稿します。「中断の可能性」の行を送る前に、すでに届いていないか Discord を確認してください。",
			},
			{
				type: "table",
				page_action_id: "shares_page",
				columns: [
					{ key: "title", label: "Entry / 記事" },
					{ key: "status", label: "Status / 状態", format: "badge" },
					{ key: "note", label: "Note / メモ" },
					{ key: "updatedAt", label: "Updated / 更新", format: "relative_time" },
					{ key: "action", label: "Action / 操作", format: "element" },
				],
				rows: items.map(({ id, data }) => {
					const link = messageLink(data.guildId, data.channelId, data.messageId);
					const action =
						data.status !== "shared"
							? { type: "button", action_id: "send", label: "Send / 送る", value: id }
							: link
								? { type: "link", label: "Open / 開く", target: { kind: "external", url: link } }
								: undefined;
					return {
						title: data.title,
						status: STATUS_LABEL[data.status],
						note: data.note ?? "",
						updatedAt: data.updatedAt,
						// Posted without a known server ID: nothing to link to, so the cell stays empty.
						...(action ? { action } : {}),
					};
				}),
				empty_text: "Nothing yet. / まだありません。",
			},
		],
		...(toast ? { toast } : {}),
	};
}

async function resend(ctx: PluginContext, key: string) {
	const current = await sharesOf(ctx).getVersioned(key);
	if (!current || current.value.status === "shared") return sharesPage(ctx);
	const entry = (await ctx.content!.get(current.value.collection, current.value.id)) as Entry | null;
	if (!entry || entry.status !== "published") {
		return sharesPage(ctx, { type: "error", message: "This entry is not published. / この記事は公開されていません。" });
	}
	// Two presses (or two admins) must not post twice.
	const claim = await sharesOf(ctx).compareAndSet(key, current.revision, {
		...current.value,
		status: "pending",
		updatedAt: new Date().toISOString(),
	});
	if (!claim.applied) return sharesPage(ctx);
	const settings = await readSettings(ctx);
	const after = await sendAndRecord(ctx, key, current.value.collection, entry, settings);
	// Only this row: reading the whole list would pass the subrequest limit.
	// Opening the page again shows the rest.
	return sharesPage(
		ctx,
		after.status === "shared"
			? { type: "success", message: "Posted. / 投稿しました。" }
			: { type: "error", message: after.note ?? "Could not post. / 投稿できませんでした。" },
		[{ id: key, data: after }],
	);
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => markStart(ctx),
		"plugin:activate": async (_event, ctx) => markStart(ctx),
		"content:afterPublish": {
			timeout: HOOK_TIMEOUT,
			handler: async (event, ctx) => {
				await shareOnPublish(ctx, event.collection, event.content as unknown as Entry);
			},
		},
	},
	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const input = routeCtx.input as { type?: unknown; action_id?: unknown; value?: unknown } | null;
				if (input?.type === "block_action" && input.action_id === "send" && typeof input.value === "string") {
					return resend(ctx, input.value);
				}
				return sharesPage(ctx);
			},
		},
	},
};

export default plugin;
