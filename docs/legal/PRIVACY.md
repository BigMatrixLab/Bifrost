# Privacy policy

Last updated: 15 November 2026.

Bifrost is built so that your files, their names and your transfer history never reach us. This policy explains the
little that does leave your device, who receives it, and why. "We" and "us" mean {{company}}, which offers Bifrost.

## The short version

- Files travel from one of your devices to another. We never receive, see or store them.
- File names, folder listings, who you share with and your transfer history stay on your devices.
- The app has no analytics, no telemetry, no crash reporting and no advertising.
- The website has no analytics or advertising, and sets no cookies.
- If you subscribe to Pro, we keep what is needed to bill you, and nothing about what you send.

## What the app sends, and to whom

Two devices on the internet need help to find each other. The app talks to these services, and only for these
purposes:

- **Discovery and relay servers.** By default these are run by the iroh project (n0). To connect your devices they
  receive each device's ID (a public key) and its IP address. When you create a short code, they hold an encrypted
  invitation they can't open, only while the invitation is active. When routers block a direct path, and on the Free
  plan after your first 50 GB, a relay forwards your transfer as end-to-end encrypted packets that it can't read and
  doesn't store. If you set your own relay under Settings, Connection, the app uses yours instead.
- **Map lookups.** While "Show devices on the map" is on (Settings, Privacy; on by default), the app sends the public
  IP address of this device and of connected devices to ipinfo.io, or to ipwho.is if that fails, to place them on the
  map at city level. Turn the setting off and no lookups are made.

The app sends nothing else. It doesn't check in with us, report usage or upload logs.

## What stays on your device

Your transfer history, privacy receipts, device names, shared folders, invitation keys (stored only as hashes),
safety words and settings are kept on the device and never synced. History is kept for one year by default; you can
choose forever, 90 days, 30 days or not at all, and you can keep sizes and receipts without file names.

## The website

The website is hosted on Cloudflare Pages, and the installers are served from Cloudflare R2. To deliver pages and
downloads and to protect them from abuse, Cloudflare processes technical request data such as your IP address and
browser details, under [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/). We add no analytics,
trackers or cookies of our own.

The live app demo on the home page stores two small values in your browser's local storage: its colour theme, and a
note that its first-run firewall prompt was shown. They never leave your browser.

## Pro subscriptions

Payments are handled by {{processor}}. When you subscribe, we receive what is needed to run the subscription: your
name, email address, country, plan, subscription status and payment references. We never receive or store full card
numbers. We use this information to charge you, send receipts, answer billing questions, prevent fraud and keep the
records the law requires. It is never linked to what you transfer, because we have no record of that.

## Why we may use your information

- To provide the service you asked for: the subscription and its billing.
- Our legitimate interest in keeping the website and downloads available and secure.
- Your choice: map lookups happen only while you leave that setting on.
- Legal obligations, such as tax and accounting records.

## How long we keep it

Billing records are kept for as long as tax and accounting law requires. Support messages are kept while we help you
and for a reasonable time after. We keep no transfer data, because we never have any.

## Who we share it with

We don't sell or rent personal information. We share it only with the services named above, which process it for us,
and with authorities when the law requires it. In that case we can hand over only what we hold: billing records.
Files, names and history are not ours to give.

## Your rights

Depending on where you live, you can ask to see, correct, export or delete the personal information we hold about
you, object to how we use it, or withdraw consent. Write to {{email}} and we will answer. You can also complain to
your local data protection authority.

## Children

Bifrost is not meant for children under 13, or under 16 where local law sets that age. We don't knowingly collect
their information.

## International transfers

Cloudflare, {{processor}} and the discovery and relay servers may process data outside your country. Where the law
requires it, those transfers are covered by appropriate safeguards.

## Changes to this policy

When this policy changes we update the date at the top. If a change affects what we collect, we say so on the website
before it takes effect.

## Contact

{{company}}, {{address}}. Email: {{email}}.
