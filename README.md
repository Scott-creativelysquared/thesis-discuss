# thesis-discuss

Discussion, sharing and share attribution for the Creatively Squared thesis page on Webflow.
No paid platforms and no runtime dependencies: a single vanilla JS file, Supabase (Postgres + Auth), LinkedIn OpenID Connect.

## What it does
- Public, ungated article and comments. LinkedIn sign-in only to comment or reply (name and photo shown, optional profile link).
- Threaded replies, author delete, admin hide/restore.
- Share to Teams (Microsoft's launcher where supported), LinkedIn, WhatsApp, email, copy link, plus Slack, Facebook, X, Bluesky, Telegram and the device share sheet. Never requires sign-in.
- Whole article, section, highlighted excerpt and individual comment sharing, each with a deep link (and a text fragment for excerpts).
- Every share action gets a unique `?ref=` token. Records channel, passage, timestamp, the sharer only if already signed in, and the parent token for referral chains. Visits, scroll depth, active reading time and comments are attributed to the token they arrived on.
- Private dashboard (admin emails only): shares and visits by channel, most shared excerpts, most discussed sections, identified sharers, comments from shared links, referral generations, moderation.

Share actions are intent (a button was used). We never claim a share was sent or who received it, and never read Teams, WhatsApp, email or Slack.

## Layout
- `sql/` database schema, functions, grants. Apply in order in the Supabase SQL editor.
- `src/` widget source. `build.mjs` bundles `dist/{article,dashboard}.{env}.js` and prints SRI hashes.
- `test/` local SQL tests and a Playwright end-to-end test against a local Postgres behind a mocked Supabase gateway.

## Webflow setup
Article page: an element with `data-thesis-content` around the article body (or the largest rich text block is used), optional `data-thesis-comments` where the discussion should mount, optional `data-thesis-share` share bars. Add the hosted `article.<env>.js` script in the page footer.
Dashboard page: one element with `data-thesis-dashboard`, page set to noindex, hosted `dashboard.<env>.js` in the footer.

Optional overrides before the script: `window.CS_THESIS = { article: 'thesis', title: '…', author: 'Scott Thomas' }`.

## Supabase setup
Auth: LinkedIn (OIDC) enabled, email provider disabled, redirect URLs include the page origin. Admins: `insert into public.admin_emails values ('name@domain')`.
Optional Slack alerts on new comments: enable `pg_net`, then set `app_settings` keys `slack_webhook_url` and `article_url`.
