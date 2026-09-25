# Meera content pipeline

Telegram note → Gemini triage → Google News RSS → Gemini draft in Meera's voice → review card in Telegram → **Meera publishes herself**.

## Setup (2 min)
1. Copy `.env.example` to `.env` and fill in the bot token, the channel Chat ID (`-100…`) and a Gemini API key (aistudio.google.com).
2. Node 18+ is needed. There's nothing to install.

## Run
| Command | What it does |
|---|---|
| `node --env-file=.env pipeline.js --try "your note"` | One note end to end, printed in the terminal (no Telegram). Add `--force` to draft a low-score note. |
| `node --env-file=.env pipeline.js` | **Main mode.** DM the bot any prompt and you get a LinkedIn post in Meera's voice + review card back. Notes in the channel are triaged first. |
| `node --env-file=.env pipeline.js --backlog sample_notes.txt --top 3 --dry` | Triage a file of old notes (separated by `---`) and draft the best ones. Drop `--dry` to send them to Telegram. |
| `node pipeline.js --stats` | Outcome metrics: drafted, approved, approval rate, posts this week vs. target 3. |

## Files
- `voice/published.txt`: Meera's 15 published pieces (the voice reference, sent to Gemini on every draft)
- `voice/style.md`: voice rules distilled from them. Edit this to tune the voice.
- `data/state.json`, `data/log.jsonl`: runtime state and the metrics log

## Guardrails (the Cut)
- The bot never posts to LinkedIn. It only replies in the private channel.
- News headlines are attached as linked references marked [VERIFY], and the prompt forbids stating anything beyond the headline.
- Any number in a draft that isn't in the note or the headline gets flagged ⚠️ automatically.
- Low-score notes are parked, not deleted. Meera can tap "Draft anyway".
