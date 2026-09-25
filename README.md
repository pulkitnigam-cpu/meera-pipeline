# Meera content pipeline

Telegram (text or voice note → transcribed) → Gemini triage 0–10 (rejects low scores) → Google News hook → Gemini draft in Meera's voice → review card in Telegram → **Meera publishes herself**.

## Layout
| File | Role |
|---|---|
| `lib/core.js` | The whole workflow. Shared by both runners. |
| `api/telegram.js` | **Vercel** webhook. Telegram POSTs updates here. It replies 200 at once and finishes the draft via `waitUntil`. |
| `lib/redis-store.js` | Vercel state (drafts for the buttons, dedupe, log) in Upstash Redis |
| `pipeline.js` | **Local** runner (polling) + CLI tools, with state in `data/` |
| `voice/published.txt`, `voice/style.md` | Meera's 15 published pieces + distilled voice rules (edit `style.md` to tune the voice) |

## Environment variables
| Name | Where | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | both | from @BotFather |
| `TELEGRAM_OWNER_ID` | both | your user ID. Only you can DM the bot. |
| `GEMINI_API_KEY` | both | aistudio.google.com |
| `GEMINI_MODEL` | both | `gemini-flash-latest` |
| `MIN_SCORE` | both | triage pass mark, default 6 |
| `WEBHOOK_SECRET` | both | random string. Must be identical in `.env` and Vercel. |
| `TELEGRAM_CHAT_ID` | optional | a capture channel (`-100…`) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel | set automatically when you connect Upstash for Redis |

## Deploy on Vercel
1. vercel.com → **Add New → Project** → import this GitHub repo → Framework preset **Other** → Deploy.
2. Project → **Storage** → **Create Database → Upstash for Redis** (free) → connect to this project.
3. Project → **Settings → Environment Variables** → add the variables above → **Deployments → Redeploy**.
4. Stop the local bot, then point Telegram at Vercel:
   `node --env-file=.env pipeline.js --set-webhook https://<your-app>.vercel.app`
5. Send the bot a note. Logs: Vercel → project → **Logs**.

To go back to running locally: `node --env-file=.env pipeline.js --delete-webhook`, then `node --env-file=.env pipeline.js`.

## Local commands
| Command | What it does |
|---|---|
| `node --env-file=.env pipeline.js --try "your note"` | One note end to end, printed in the terminal (no Telegram). `--force` drafts even a low score. |
| `node --env-file=.env pipeline.js` | Poll Telegram from this laptop (refuses if the Vercel webhook is set) |
| `node --env-file=.env pipeline.js --backlog sample_notes.txt --top 3 --dry` | Triage a file of old notes (separated by `---`) and draft the best |
| `node --env-file=.env pipeline.js --webhook-info` | Where Telegram is sending updates right now |
| `node pipeline.js --stats` | Local metrics: drafted, approved, approval rate, posts this week vs. target 3 |

## Guardrails (the Cut)
- The bot never posts to LinkedIn. It only replies to you in Telegram.
- News headlines are attached as linked references marked [VERIFY], and the prompt forbids stating anything beyond the headline.
- Any number in a draft that isn't in the note or the headline is flagged ⚠️ by plain code, not by the AI.
- Low-score notes are rejected with a reason. You can still tap "Draft anyway", so the final call stays with you.
- The webhook rejects any request without Telegram's secret header, and only the owner's DMs are processed.
