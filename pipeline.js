// Meera content pipeline, local runner. The workflow itself lives in lib/core.js (shared with the Vercel webhook in api/telegram.js).
// No dependencies (Node 20+). Run with your keys in .env:
//   node --env-file=.env pipeline.js                      poll Telegram from this laptop (only when the Vercel webhook is OFF)
//   node --env-file=.env pipeline.js --try "note text"    run one note end to end, print to console, no Telegram
//   node --env-file=.env pipeline.js --backlog notes.txt [--top 5] [--dry]   triage old notes, draft the best ones
//   node --env-file=.env pipeline.js --set-webhook https://<app>.vercel.app   hand Telegram over to Vercel
//   node --env-file=.env pipeline.js --webhook-info       show where Telegram is sending updates
//   node --env-file=.env pipeline.js --delete-webhook     take Telegram back from Vercel (to run locally again)
//   node pipeline.js --news "niacinamide"                 test the RSS fetch only
//   node pipeline.js --stats                              outcome metrics from the local log

const fs = require('fs');
const path = require('path');
const core = require('./lib/core');

const DATA = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'log.jsonl');
fs.mkdirSync(DATA, { recursive: true });

// ---------- local file store (same interface as lib/redis-store.js) ----------
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { offset: 0, notes: {} }; } };
const state = loadState();
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const store = {
  async getNote(id) { return state.notes[id] || null; },
  async saveNote(id, rec) { state.notes[id] = rec; saveState(); },
  async log(event, data) { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n'); },
};

async function listen() {
  for (const k of ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']) if (!process.env[k]) throw new Error(`${k} missing in .env`);
  const hook = await core.tg('getWebhookInfo');
  if (hook.url) throw new Error(`Telegram is sending updates to ${hook.url} (Vercel). The bot is already live there.\nTo run locally instead: node --env-file=.env pipeline.js --delete-webhook`);
  const me = await core.tg('getMe');
  console.log(`Listening locally as @${me.username} (model ${core.MODEL}).`);
  console.log(`  • Private chat: text or voice note -> triage -> news -> draft${core.OWNER_ID ? ` (owner ${core.OWNER_ID} only)` : ' (send /start first to get your owner ID)'}`);
  if (core.CHAT_ID) console.log(`  • Channel ${core.CHAT_ID}`);
  console.log('Ctrl+C to stop.');
  for (;;) {
    let updates = [];
    try { updates = await core.tg('getUpdates', { offset: state.offset, timeout: 30, allowed_updates: ['message', 'channel_post', 'callback_query'] }); }
    catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 5000)); continue; }
    for (const u of updates) {
      state.offset = u.update_id + 1;
      saveState();
      await core.handleUpdate(u, store);
    }
  }
}

async function setWebhook(base) {
  if (!base) throw new Error('Usage: --set-webhook https://<your-app>.vercel.app');
  if (!process.env.WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET missing in .env (must match the one set in Vercel)');
  const url = base.replace(/\/+$/, '').replace(/\/api\/telegram$/, '') + '/api/telegram';
  const ping = await fetch(url).then(r => r.text()).catch(e => e.message);
  if (!/webhook is up/.test(ping)) throw new Error(`${url} doesn't look deployed yet (got: ${ping.slice(0, 120)})`);
  await core.tg('setWebhook', { url, secret_token: process.env.WEBHOOK_SECRET, allowed_updates: ['message', 'channel_post', 'callback_query'], drop_pending_updates: true });
  console.log(`✅ Telegram now sends updates to ${url}\nThe bot runs on Vercel 24/7. Don't run the local listener while this is set.`);
}

// Backlog: the bot can't read messages posted before it joined, so export the old notes to a file (separate notes with a line of ---).
async function backlog(file, top, dry) {
  const raw = fs.readFileSync(file, 'utf8');
  const notes = (raw.includes('\n---') ? raw.split(/\n-{3,}\s*\n/) : raw.split(/\n\s*\n/)).map(s => s.trim()).filter(Boolean);
  console.log(`Triaging ${notes.length} notes...`);
  const scored = [];
  for (const [i, note] of notes.entries()) {
    const t = await core.triage(note);
    scored.push({ i, note, t });
    console.log(`${String(i + 1).padStart(3)}. [${t.score}/10] ${t.category.padEnd(22)} ${note.replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  scored.sort((a, b) => b.t.score - a.t.score);
  fs.writeFileSync(path.join(DATA, 'backlog_ranked.json'), JSON.stringify(scored, null, 2));
  const passing = scored.filter(s => s.t.score >= core.MIN_SCORE);
  const pick = passing.slice(0, top);
  console.log(`\n${passing.length} notes scored ${core.MIN_SCORE}+. Drafting top ${pick.length}. Full ranking saved to data/backlog_ranked.json`);
  const chatId = core.OWNER_ID || core.CHAT_ID;
  for (const s of pick) {
    if (!dry) await core.sendTo(chatId, `🗂 Backlog note #${s.i + 1}:\n\n${s.note}`);
    await core.processNote(s.note, { id: `b${s.i}`, store, dry, force: true, chatId });
  }
}

function stats() {
  const lines = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const c = (e) => lines.filter(l => l.event === e).length;
  const drafted = c('drafted'), approved = c('approved');
  console.log({ notes_triaged: c('triaged'), drafted, approved, skipped: c('skipped'), redos: c('redo'),
    approval_rate: drafted ? `${Math.round(100 * approved / drafted)}%` : 'n/a',
    approved_last_7_days: lines.filter(l => l.event === 'approved' && Date.now() - new Date(l.ts) < 7 * 864e5).length + ' (target 3)' });
}

// ---------- CLI ----------
(async () => {
  const a = process.argv.slice(2);
  const arg = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  try {
    if (a.includes('--news')) console.log(await core.fetchNews([arg('--news')]));
    else if (a.includes('--try')) await core.processNote(arg('--try'), { id: 'try', dry: true, force: a.includes('--force') });
    else if (a.includes('--backlog')) await backlog(arg('--backlog'), Number(arg('--top') || 5), a.includes('--dry'));
    else if (a.includes('--set-webhook')) await setWebhook(arg('--set-webhook'));
    else if (a.includes('--webhook-info')) console.log(await core.tg('getWebhookInfo'));
    else if (a.includes('--delete-webhook')) { await core.tg('deleteWebhook', {}); console.log('Webhook removed. You can run the local listener again.'); }
    else if (a.includes('--stats')) stats();
    else await listen();
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
