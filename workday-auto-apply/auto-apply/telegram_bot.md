# Telegram Bot Setup — Workday Auto-Apply Bot (Production Phase)

Kept separate from the core doc set per instruction — this is setup/ops, not product spec.

---

## 1. What "QR-scan linking" actually is (technical clarification)

Telegram's Bot API has **no native "scan this QR to log in" mechanism for bots** (that pattern — QR + phone confirms — is specific to Telegram Desktop/Web *client* login, not bot interactions). What this build implements instead, and what matches your described flow, is a **deep-link QR**:

- A QR code encodes a URL of the form `https://t.me/<your_bot_username>?start=<token>`.
- Scanning it with a phone camera opens the Telegram app directly into a chat with your bot, with `<token>` passed to the bot's `/start` handler.
- From there, the bot asks for the user's email in-chat — this is where "the user enters their respective mail id" happens, exactly as you described.
- The bot already holds that user's Workday password (captured once at pilot onboarding, stored encrypted in Supabase) — no password is ever typed into Telegram.

**Flag:** if you meant something other than this (e.g. a fully custom QR-based session-pairing system independent of Telegram's own mechanisms), let me know — the above is the standard, supported way to achieve the flow you described.

---

## 2. BotFather Setup

1. Open Telegram, message **@BotFather**.
2. `/newbot` → choose a display name → choose a unique `@username` ending in `bot` (e.g. `WorkdayAutoApplyBot`).
3. BotFather returns a **bot token** — format `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. This is a secret — store in `.env` as `TELEGRAM_BOT_TOKEN`, never commit it.
4. Optional but recommended: `/setdescription`, `/setabouttext`, `/setuserpic` for a professional presentation to your pilot users.
5. Optional: `/setcommands` to register:
   ```
   start - Link your account
   status - Check your application status
   pause - Pause job matching
   resume - Resume job matching
   ```

---

## 3. Environment Variables

```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_BOT_USERNAME=<your bot's @username, without the @>
SUPABASE_URL=<your Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<service role key — server-side only, never exposed to any client>
ENCRYPTION_KEY=<key used to encrypt/decrypt workday_credentials.workday_password_encrypted>
```

---

## 4. Deep-Link QR Generation

Per onboarding request (e.g. you manually triggering onboarding for a pilot user, or a lightweight admin script):

1. Generate a random opaque token (e.g. `crypto.randomUUID()`), store it against a pending `telegram_links` row (`link_token` column — see `backend-schema.md` §2.2).
2. Build the deep link: `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>`.
3. Render as a QR image using the `qrcode` npm package:
   ```js
   import QRCode from 'qrcode';
   await QRCode.toFile('onboarding-qr.png', deepLink);
   ```
4. Deliver the QR image to the pilot user out-of-band (email/print/etc.) — scanning it opens their Telegram to your bot with the token pre-attached.

---

## 5. Bot Handlers Required

| Handler | Trigger | Behavior |
|---|---|---|
| `/start <token>` | User opens deep link | Look up `telegram_links` by `link_token`; if found and unlinked, prompt for email |
| Email message (post-`/start`) | Free-text reply | Match against `users.email`; on match, set `telegram_links.telegram_chat_id`, `linked_at`; trigger Prod-1 login flow; on no match, respond that no account was found for that email |
| Inline button `Apply` / `Skip` | User taps button on job-match message | Update `applications.status`; on `Apply`, enqueue the apply-run |
| Free-text reply (question-escalation context) | User answers an unknown-question prompt | Capture reply, apply to pending form fill, insert into `qa_answers` |
| `/status` | User command | Query `applications` for that user, summarize recent statuses |
| `/pause`, `/resume` | User command | Toggle `users.status` between `active`/`paused` |

---

## 6. Library Choice

Use **`node-telegram-bot-api`** (polling mode is sufficient for a 2-user pilot; no public webhook/HTTPS endpoint required) or **`grammY`** if you prefer a more modern TypeScript-friendly API. Either integrates cleanly with the existing `.mjs` module style used elsewhere in this project — keep it in `lib/telegram/bot.mjs`.

```js
import TelegramBot from 'node-telegram-bot-api';
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
```

---

## 7. Security Notes

- Bot token and Supabase service role key are backend-only secrets — this bot has no browser/client component, so there is no exposure surface beyond your server environment.
- Never log the decrypted Workday password, even at debug level.
- Rate-limit inbound message handling per `telegram_chat_id` to avoid a single user's rapid replies desyncing the escalation-answer flow.
