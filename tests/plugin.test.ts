import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

const SITE = "https://example.com";
const TOKEN = "secret-Token_123";
const HOOK = `https://discord.com/api/webhooks/42/${TOKEN}`;
const SEND = `${HOOK}?wait=true`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const message = { id: "m1", channel_id: "c1", guild_id: "g1" };

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

/** `webhookUrl: null` leaves the setting unset. */
async function setup({ webhookUrl = HOOK as string | null } = {}) {
	host = await createPluginRuntimeTestHost({
		site: { url: SITE, name: "Site", locale: "ja" },
		i18n: { defaultLocale: "ja", locales: ["ja", "en"] } as never,
	});
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/posts/{slug}",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "excerpt", label: "Excerpt", type: "text" },
			{ slug: "featured_image", label: "Image", type: "image" },
		],
	} as never);
	await host.actions.plugin.activate();
	if (webhookUrl !== null) await host.fixtures.plugin.setting("webhookUrl", webhookUrl);
	return host;
}

async function draft(h: PluginRuntimeTestHost, data: Record<string, unknown> = {}) {
	return h.fixtures.content("posts", {
		slug: "hello",
		status: "draft",
		locale: "ja",
		data: { title: "こんにちは", excerpt: "抜粋", ...data },
	});
}

async function publish(h: PluginRuntimeTestHost, id: string) {
	const result = await h.actions.content.publish("posts", id);
	expect(result.success).toBe(true);
	await h.waitForDeferredTasks();
}

const posts = (h: PluginRuntimeTestHost) => h.http.requests().filter((request) => request.url === SEND);
const bodyOf = (request: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(request.body));

async function onlyShare(h: PluginRuntimeTestHost) {
	const shares = await h.inspect.storage.list<{
		status: string;
		note?: string;
		messageId?: string;
		guildId?: string;
	}>("shares");
	expect(shares).toHaveLength(1);
	return shares[0]!;
}

describe("content:afterPublish", () => {
	it("posts a new entry once, as a card with a working link and no mentions", async () => {
		const h = await setup();
		await h.http.respond(SEND, json(message));
		const entry = await draft(h);
		await publish(h, entry.id);

		expect(posts(h)).toHaveLength(1);
		const body = bodyOf(posts(h)[0]!);
		expect(body.content).toBe("");
		expect(body.embeds[0].title).toBe("こんにちは");
		expect(body.embeds[0].url).toBe(`${SITE}/posts/hello`);
		expect(body.embeds[0].description).toBe("抜粋");
		expect(body.embeds[0].image).toBeUndefined();
		expect(body.allowed_mentions).toEqual({ parse: [] });
		const share = await onlyShare(h);
		expect(share.data.status).toBe("shared");
		expect(share.data.messageId).toBe("m1");

		// Publishing again must not post again.
		await publish(h, entry.id);
		expect(posts(h)).toHaveLength(1);
	});

	it("uses the templates, the time zone and the collection list", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("collections", " Pages, POSTS ");
		await h.fixtures.plugin.setting("content", "New in {collection} on {date}: {url}");
		await h.fixtures.plugin.setting("embedTitle", "📰 {title}");
		await h.fixtures.plugin.setting("embedDescription", "");
		await h.fixtures.plugin.setting("timeZone", "Asia/Tokyo");
		await h.http.respond(SEND, json(message));
		const entry = await draft(h);
		await publish(h, entry.id);

		const body = bodyOf(posts(h)[0]!);
		expect(body.content).toMatch(new RegExp(`^New in posts on \\d{4}-\\d{2}-\\d{2}: ${SITE}/posts/hello$`));
		expect(body.embeds[0].title).toBe("📰 こんにちは");
		expect(body.embeds[0].description).toBeUndefined();
	});

	it("shows the featured image by its public URL, unless turned off", async () => {
		const h = await setup();
		await h.http.respond(SEND, json(message));
		const media = await h.fixtures.media({ filename: "t.png", mimeType: "image/png", bytes: PNG, width: 1200, height: 630 });
		const image = { id: media.id, provider: "local", meta: { storageKey: "01KEY.png" } };
		const entry = await draft(h, { featured_image: image });
		await publish(h, entry.id);
		expect(bodyOf(posts(h)[0]!).embeds[0].image).toEqual({ url: `${SITE}/_emdash/api/media/file/01KEY.png` });

		await h.fixtures.plugin.setting("includeImage", false);
		await h.http.respond(SEND, json(message));
		const second = await h.fixtures.content("posts", {
			slug: "second",
			status: "draft",
			locale: "ja",
			data: { title: "二つ目", featured_image: image },
		});
		await publish(h, second.id);
		expect(bodyOf(posts(h)[1]!).embeds[0].image).toBeUndefined();
	});

	it("asks Discord for the server ID when the reply leaves it out", async () => {
		const h = await setup();
		await h.http.respond(SEND, json({ id: "m1", channel_id: "c1" }));
		await h.http.respond(HOOK, json({ id: "42", guild_id: "g9", channel_id: "c1" }));
		const entry = await draft(h);
		await publish(h, entry.id);

		expect((await onlyShare(h)).data.guildId).toBe("g9");
		const page = await h.admin.loadPage("/shares");
		expect(JSON.stringify(page.blocks)).toContain("https://discord.com/channels/g9/c1/m1");
	});

	it("does not post an entry that was published before the plugin started", async () => {
		const h = await setup();
		const old = await h.fixtures.content("posts", {
			slug: "old",
			status: "published",
			publishedAt: "2020-01-01T00:00:00.000Z",
			data: { title: "古い記事" },
		});
		await publish(h, old.id);
		expect(h.http.requests()).toHaveLength(0);
		expect(await h.inspect.storage.list("shares")).toHaveLength(0);
	});

	it("ignores collections that are not selected", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("collections", "works");
		const entry = await draft(h);
		await publish(h, entry.id);
		expect(h.http.requests()).toHaveLength(0);
		expect(await h.inspect.storage.list("shares")).toHaveLength(0);
	});

	it("posts nothing when the collection list is empty", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("collections", "");
		const entry = await draft(h);
		await publish(h, entry.id);
		expect(h.http.requests()).toHaveLength(0);
		expect(await h.inspect.storage.list("shares")).toHaveLength(0);
	});

	it("records an unconfigured site as not sent, and sends nothing", async () => {
		const h = await setup({ webhookUrl: null });
		const entry = await draft(h);
		await publish(h, entry.id);
		expect(h.http.requests()).toHaveLength(0);
		expect((await onlyShare(h)).data.status).toBe("skipped");
	});

	it("does not send to a URL that is not a Discord webhook", async () => {
		const h = await setup({ webhookUrl: "https://evil.example/api/webhooks/42/abc" });
		const entry = await draft(h);
		await publish(h, entry.id);
		expect(h.http.requests()).toHaveLength(0);
		const share = await onlyShare(h);
		expect(share.data.status).toBe("skipped");
		expect(share.data.note).toContain("not a Discord webhook URL");
	});

	it("records a failure without the token, and does not retry by itself", async () => {
		const h = await setup();
		await h.http.respond(SEND, json({ message: `Unknown Webhook ${TOKEN}`, code: 10015 }, 404));
		const entry = await draft(h);
		await publish(h, entry.id);

		const share = await onlyShare(h);
		expect(share.data.status).toBe("failed");
		expect(share.data.note).toContain("HTTP 404");
		expect(JSON.stringify(share)).not.toContain(TOKEN);

		await publish(h, entry.id);
		expect(posts(h)).toHaveLength(1);
	});

	it("records Discord's rate limit with the wait time", async () => {
		const h = await setup();
		await h.http.respond(SEND, json({ message: "You are being rate limited.", retry_after: 2.4, global: false }, 429));
		const entry = await draft(h);
		await publish(h, entry.id);

		const share = await onlyShare(h);
		expect(share.data.status).toBe("failed");
		expect(share.data.note).toContain("HTTP 429");
		expect(share.data.note).toContain("3 s");
	});
});

describe("translations", () => {
	it("posts once for an entry and its translation", async () => {
		const h = await setup();
		await h.http.respond(SEND, json(message));
		const entry = await draft(h);
		await publish(h, entry.id);
		const english = await h.fixtures.content("posts", {
			slug: "hello",
			status: "draft",
			locale: "en",
			translationOf: entry.id,
			data: { title: "Hello" },
		});
		await publish(h, english.id);
		expect(posts(h)).toHaveLength(1);
	});
});

describe("admin page", () => {
	it("sends a failed entry again, and only once", async () => {
		const h = await setup();
		await h.http.respond(SEND, json({ message: "Oops" }, 500));
		const entry = await draft(h);
		await publish(h, entry.id);
		const share = await onlyShare(h);
		expect(share.data.status).toBe("failed");

		await h.http.respond(SEND, json(message));
		const page = await h.admin.act("/shares", "send", { value: share.id });
		expect(page.toast?.type).toBe("success");
		expect(posts(h)).toHaveLength(2);
		expect((await onlyShare(h)).data.status).toBe("shared");

		await h.admin.act("/shares", "send", { value: share.id });
		expect(posts(h)).toHaveLength(2);
	});

	it("shows the list with a link to the message", async () => {
		const h = await setup();
		await h.http.respond(SEND, json(message));
		const entry = await draft(h);
		await publish(h, entry.id);
		const page = await h.admin.loadPage("/shares");
		expect(JSON.stringify(page.blocks)).toContain("https://discord.com/channels/g1/c1/m1");
	});
});
