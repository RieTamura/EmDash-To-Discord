# EmDash To Discord

An EmDash plugin that posts a card to a Discord channel once, when an entry is first published. The card has the title, link, excerpt and featured image.

[日本語](README_JA.md)

## Features

- **Only a webhook URL.** No bot to create and no sign-in.
- **The featured image shows on the card.** It uses the standard `featured_image` field. Discord fetches the image from your site, so no image data is sent.
- **Connects only to Discord.** Requests can go only to `discord.com`, so the webhook URL can't be sent anywhere else.
- **Never posts twice.** A record is saved before sending, so an interrupted run is never retried by itself. An entry and its translations share one post.
- **Notifies nobody.** Mentions such as `@everyone` in a title or template never send a notification.

## How it behaves

- Entries published before the plugin was installed are never posted, even when updated.
- Nothing is retried automatically. The admin page "Discord Share" lists each entry's status, with a "Send" button for failed or unsent ones. After a Discord rate limit (429), wait the number of seconds shown in the note, then send.
- Updating or deleting an entry leaves the Discord post as it is.
- The card uses the featured image the entry has when it is published. An image added later doesn't appear.
- If Discord can't read the image from your site, the card has no image.

## Installation

There are two ways to install it.

| Source | Runs in | Cloudflare plan | Install and update |
| --- | --- | --- | --- |
| EmDash plugin registry | Sandbox | **Workers Paid** (needed for the sandbox) | From the admin |
| GitHub | Your site's worker | **Works on Workers Free** | `npm install`, then **deploy** |

### From the registry

Find **EmDash To Discord** under **Registry** in the admin and install it.

A sandbox allows 10 requests per run before EmDash 1.5 and 30 from 1.5. This plugin makes at most 7 per publish and at most 8 per resend from the admin, so it works with either limit.

### From GitHub

```sh
npm install github:RieTamura/EmDash-To-Discord
```

Add it to `astro.config.mjs`:

```js
import discordShare from "discord-share";

emdash({
	// ...
	plugins: [discordShare],
});
```

Then deploy. To update, run the same `npm install` and deploy again; the admin can't update it.

## Setup

### 1. Set an encryption key

The webhook URL is encrypted with the site's `EMDASH_ENCRYPTION_KEY`. If the site doesn't have one yet, create it and save it to the Worker:

```sh
npx emdash secrets generate
npx wrangler secret put EMDASH_ENCRYPTION_KEY
```

**Keep a copy of the key somewhere else.** It isn't in database backups, and without it the saved URL can't be read.

### 2. Create a webhook

In Discord, open the channel's **Edit Channel → Integrations → Webhooks → New Webhook**, then **Copy Webhook URL**. You can also set the name and avatar the posts show here.

**Anyone with this URL can post to the channel.** Don't share it or put it anywhere public. If it leaks, delete the webhook in Discord, make a new one, and put the new URL in the plugin's settings.

To stop posting, empty the Collections setting or disable the plugin. Saving the Webhook URL field empty keeps the previous URL.

### 3. Configure the plugin

| Setting | Meaning |
| --- | --- |
| Webhook URL | The URL from step 2 |
| Collections | Separated by commas. Default: `posts`. Empty means nothing is posted |
| Text above the card | Default: empty (card only). Up to 2000 characters |
| Card title | Default: `{title}`. Up to 256 characters. Empty means `{title}` |
| Card description | Default: `{excerpt}`. Up to 4096 characters. Empty means no description |
| Show the featured image | Default: on |
| Time zone for `{date}` | Such as `Asia/Tokyo`. Default: `UTC` |

Templates can use these variables. Text over a limit is cut and ends with "…". Unknown variables are left as they are.

| Variable | Value |
| --- | --- |
| `{title}` | The entry's title |
| `{url}` | The entry's public URL |
| `{excerpt}` | The excerpt |
| `{date}` | The publish date (`YYYY-MM-DD`) |
| `{collection}` | The collection's name |

**Don't add collections that import posts from other services (RSS, Bluesky and so on).** The imported posts would be posted.

## Development

```sh
npm install
npm test
npm run build
```

The tests run on the Worker Loader, but they don't reproduce production CPU and request limits.

## License

[MIT](LICENSE)
