import { describe, expect, it } from "vitest";

import {
	buildMessage,
	DEFAULTS,
	featuredImageUrl,
	fill,
	formatDate,
	LIMITS,
	messageLink,
	parseWebhookUrl,
	shorten,
	webhookEndpoint,
} from "../src/message";

const URL_ = "https://example.com/posts/hello";
const fields = {
	title: "こんにちは",
	url: URL_,
	excerpt: "抜粋です",
	collection: "posts",
	publishedAt: "2026-11-13T23:30:00.000Z",
};

describe("fill", () => {
	it("fills every variable", () => {
		expect(fill("{title}|{url}|{excerpt}|{date}|{collection}", fields)).toBe(
			`こんにちは|${URL_}|抜粋です|2026-11-13|posts`,
		);
	});

	it("leaves unknown variables as they are", () => {
		expect(fill("{foo} {title}", fields)).toBe("{foo} こんにちは");
	});

	it("does not fill variables that come from the title", () => {
		expect(fill("{title} {url}", { ...fields, title: "about {url}" })).toBe(`about {url} ${URL_}`);
	});
});

describe("formatDate", () => {
	it("uses the time zone", () => {
		expect(formatDate(fields.publishedAt, "Asia/Tokyo")).toBe("2026-11-14");
		expect(formatDate(fields.publishedAt, "UTC")).toBe("2026-11-13");
	});

	it("falls back to UTC for an unknown zone, and to empty for no date", () => {
		expect(formatDate(fields.publishedAt, "Mars/Base")).toBe("2026-11-13");
		expect(formatDate(null)).toBe("");
		expect(formatDate("not a date")).toBe("");
	});
});

describe("shorten", () => {
	it("keeps short text", () => {
		expect(shorten("abc", 3)).toBe("abc");
	});

	it("cuts to the limit with an ellipsis, without splitting an emoji", () => {
		const out = shorten("ab👍🏽cd", 5);
		expect(out.length).toBeLessThanOrEqual(5);
		expect(out).toBe("ab…");
	});
});

describe("buildMessage", () => {
	it("makes a card with the defaults and no mentions", () => {
		const message = buildMessage({ ...DEFAULTS }, { ...fields, imageUrl: "https://example.com/i.png" });
		expect(message).toEqual({
			content: "",
			embeds: [
				{
					title: "こんにちは",
					url: URL_,
					description: "抜粋です",
					image: { url: "https://example.com/i.png" },
					timestamp: "2026-11-13T23:30:00.000Z",
				},
			],
			allowed_mentions: { parse: [] },
		});
	});

	it("falls back to {title} when the title template comes out empty", () => {
		const message = buildMessage({ content: "", title: "  ", description: "" }, fields);
		expect(message.embeds[0]!.title).toBe("こんにちは");
		expect(message.embeds[0]).not.toHaveProperty("description");
	});

	it("keeps every part within Discord's limits", () => {
		const long = "あ".repeat(5000);
		const message = buildMessage(
			{ content: "{title}", title: "{title}", description: "{title}" },
			{ ...fields, title: long },
		);
		expect(message.content.length).toBe(LIMITS.content);
		expect(message.embeds[0]!.title.length).toBe(LIMITS.title);
		expect(message.embeds[0]!.description!.length).toBe(LIMITS.description);
		expect(message.embeds[0]!.title.endsWith("…")).toBe(true);
	});
});

describe("parseWebhookUrl", () => {
	it("reads Discord webhook URLs and sends them all to discord.com", () => {
		for (const url of [
			"https://discord.com/api/webhooks/123/abc-DEF_9",
			" https://discordapp.com/api/webhooks/123/abc-DEF_9/ ",
			"https://canary.discord.com/api/v10/webhooks/123/abc-DEF_9",
		]) {
			const hook = parseWebhookUrl(url);
			expect(hook).toEqual({ id: "123", token: "abc-DEF_9" });
			expect(webhookEndpoint(hook!)).toBe("https://discord.com/api/webhooks/123/abc-DEF_9");
		}
	});

	it("refuses anything else", () => {
		for (const url of [
			undefined,
			"",
			"not a url",
			"http://discord.com/api/webhooks/123/abc",
			"https://evil.example/api/webhooks/123/abc",
			"https://discord.com.evil.example/api/webhooks/123/abc",
			"https://discord.com/api/webhooks/123",
			"https://discord.com/api/webhooks/abc/def",
		]) {
			expect(parseWebhookUrl(url)).toBeUndefined();
		}
	});
});

describe("featuredImageUrl", () => {
	it("serves an uploaded image from the site's media path", () => {
		expect(featuredImageUrl({ id: "m1", provider: "local", meta: { storageKey: "01ABC.png" } }, URL_)).toBe(
			"https://example.com/_emdash/api/media/file/01ABC.png",
		);
	});

	it("uses an external image's own URL", () => {
		expect(featuredImageUrl({ src: "https://cdn.example/x.jpg" }, URL_)).toBe("https://cdn.example/x.jpg");
	});

	it("gives nothing without an image", () => {
		expect(featuredImageUrl(null, URL_)).toBeUndefined();
		expect(featuredImageUrl({ id: "m1" }, URL_)).toBeUndefined();
	});
});

describe("messageLink", () => {
	it("needs all three IDs", () => {
		expect(messageLink("1", "2", "3")).toBe("https://discord.com/channels/1/2/3");
		expect(messageLink(undefined, "2", "3")).toBeUndefined();
	});
});
