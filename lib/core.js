// Core workflow, shared by the local runner (pipeline.js) and the Vercel webhook (api/telegram.js):
// Telegram (voice -> text) -> Gemini triage 0-10 -> Google News hook -> Gemini draft in Meera's voice -> review gate.
// Storage is injected: `store` = { getNote(id), saveNote(id, rec), log(event, data) }, all async.

const fs = require('fs');
const path = require('path');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '');
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MIN_SCORE = Number(process.env.MIN_SCORE || 6); // triage scale is 0-10

const VOICE_DIR = path.join(__dirname, '..', 'voice');
const VOICE_SAMPLES = fs.readFileSync(path.join(VOICE_DIR, 'published.txt'), 'utf8');
const STYLE = fs.readFileSync(path.join(VOICE_DIR, 'style.md'), 'utf8');

// fetch with one retry: flaky wifi shows up as "fetch failed"
const fetchRetry = (url, opts) => fetch(url, opts).catch(() => new Promise(r => setTimeout(r, 2000)).then(() => fetch(url, opts)));

// ---------- Gemini ----------
async function gemini(system, user, { temperature = 0.7 } = {}) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY missing');
  const res = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: Array.isArray(user) ? user : [{ text: user }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${j.error?.message || JSON.stringify(j)}`);
  const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  try { return JSON.parse(text); } catch { throw new Error('Gemini returned non-JSON: ' + text.slice(0, 300)); }
}

// Step 1: triage. Score the note and pull out keywords for the news search. It recommends; Meera decides.
async function triage(note) {
  const system = `You screen raw notes from Meera Pillai, founder of Skinstinct (science-first Indian skincare brand, ex-pharma formulator), for LinkedIn post potential.
Her audience: 28-40 year old urban Indian women and wholesale buyers who reward precise formulation science, not marketing.
Her proven categories: Ingredient Deep-Dive, Founder Story, India-Specific Context, Industry Transparency, Consumer Education, Formulation Science, Brand Philosophy.
Publishability score 0-10:
9-10 = specific insight or first-hand observation with a clear teaching point; could carry a 400-word post on its own
7-8 = strong kernel, needs shaping
5-6 = usable only if paired with a current news angle
3-4 = vague, generic, or mostly a feeling
0-2 = not publishable (private, logistical, a to-do, would require claims she can't support, or outside skincare/cosmetics/her brand entirely)
If the note is phrased as a request ("give me a draft about X", "write on Y"), do NOT penalise the phrasing: score the topic X/Y on how well it fits her expertise and how specific it is. A broad on-brand topic with no detail is 5-6; an off-brand topic stays 0-2.
Return JSON: {"score": int, "category": string, "reason": string (one sentence), "angle": string (the one point the post should make), "keywords": [2-3 short Google News search terms, specific to skincare/cosmetics/India where relevant]}`;
  return gemini(system, `NOTE:\n${note}`, { temperature: 0.2 });
}

// Step 0: voice note -> text. Telegram hands us the audio file; Gemini transcribes it.
async function transcribe(file) {
  const f = await tg('getFile', { file_id: file.file_id });
  const res = await fetchRetry(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.file_path}`);
  const data = Buffer.from(await res.arrayBuffer()).toString('base64');
  const r = await gemini(
    'You transcribe voice notes from Meera Pillai, a skincare founder. Transcribe verbatim in the language spoken (Indian English, may mix Hindi words). Keep technical terms (pH, niacinamide, CoA, INCI) exactly. Remove only filler sounds (um, uh). Return JSON {"text": string}.',
    [{ inlineData: { mimeType: file.mime_type || 'audio/ogg', data } }, { text: 'Transcribe this voice note.' }],
    { temperature: 0 });
  return (r.text || '').trim();
}

// Step 2: draft in her voice. News is reference context, never asserted as fact (the Cut).
async function draft(note, t, news, { redo = false, previous = '' } = {}) {
  const system = `You are ghost-drafting a LinkedIn post for Meera Pillai. It must read as if she wrote it herself.

VOICE RULES:
${STYLE}

HER PUBLISHED WRITING (the only voice reference; match tone, rhythm, structure and honesty; do not copy sentences):
<<<
${VOICE_SAMPLES}
>>>

HARD RULES (her credibility depends on these):
1. Every fact, number, percentage, study, date or named event must come from the NOTE or from a CURRENT HEADLINE below. Never invent or "recall" statistics, studies, regulations or quotes.
2. If you use a headline, attribute it in the text ("A report in <source> this week...") and only state what the headline itself says.
3. If the note implies something needs a fact she hasn't given, write around it or leave a bracket like [Meera: add your batch data here]. Do not fill it in.
4. No medical or efficacy guarantees, no competitor brand names, no hashtags, no emojis, no exclamation marks, no sales CTA.
5. 300-500 words, 5-8 paragraphs, plain text.

Return JSON:
{"post": string,
 "headline_used": integer index of the headline used, or null,
 "claims_to_verify": [every factual or technical claim in the post that Meera should confirm before publishing, each short],
 "note_to_meera": string (one line: what you took from the note and any gap she should fill)}`;
  const headlines = news.length
    ? news.map((n, i) => `[${i}] ${n.title} (${n.source}, ${n.date}) ${n.link}`).join('\n')
    : '(none found; write from the note alone)';
  const user = `NOTE:\n${note}\n\nTRIAGE: category=${t.category}; angle=${t.angle}\n\nCURRENT HEADLINES (use the most relevant one as the post's news hook, attributed to its source; if none is genuinely about the note's topic, use none rather than forcing it):\n${headlines}` +
    (redo ? `\n\nMeera rejected the previous draft. Take a clearly different opening and structure. Previous draft:\n${previous}` : '');
  return gemini(system, user, { temperature: redo ? 0.95 : 0.7 });
}

// Deterministic guardrail: any number in the draft that isn't in the note or the headline titles gets flagged.
function unsourcedNumbers(post, note, news) {
  const source = (note + ' ' + news.map(n => n.title).join(' ')).replace(/,/g, '');
  const nums = [...new Set((post.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []))];
  return nums.filter(n => !new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}([^\\d]|$)`).test(source));
}

// ---------- Google News RSS ----------
const decode = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).trim();

async function fetchNews(keywords, { days = 14, max = 3 } = {}) {
  const seen = new Set(); const out = [];
  for (const kw of keywords.slice(0, 3)) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${kw} when:${days}d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
    try {
      const xml = await (await fetchRetry(url)).text();
      for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
        const get = (tag) => decode((item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');
        const source = get('source');
        let title = get('title');
        if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
        const key = title.toLowerCase().slice(0, 60);
        if (!title || seen.has(key)) continue;
        seen.add(key);
        out.push({ title, source, link: get('link'), date: new Date(get('pubDate')).toISOString().slice(0, 10), kw });
        if (out.filter(o => o.kw === kw).length >= 2) break; // spread across keywords
      }
    } catch (e) { console.warn('RSS failed for', kw, e.message); }
  }
  return out.slice(0, max);
}

// ---------- Telegram ----------
async function tg(method, body) {
  const res = await fetchRetry(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}
const sendTo = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true, ...extra });
const buttons = (id, rows) => ({ reply_markup: { inline_keyboard: rows.map(r => r.map(([label, action]) => ({ text: label, callback_data: `${action}:${id}` }))) } });

// ---------- core flow ----------
async function processNote(note, { id, replyTo, store, dry = false, force = false, chatId = CHAT_ID } = {}) {
  const send = (text, extra = {}) => sendTo(chatId, text, extra);
  const t = await triage(note);
  const prev = store ? (await store.getNote(id))?.previous : undefined; // kept so Redo knows what to move away from
  const rec = { note, triage: t, created: new Date().toISOString(), status: 'triaged', previous: prev };
  await store?.log('triaged', { id, score: t.score, category: t.category });

  if (t.score < MIN_SCORE && !force) {
    rec.status = 'rejected';
    await store?.saveNote(id, rec);
    const msg = `🚫 Rejected by triage: score ${t.score}/10 (needs ${MIN_SCORE}+) · ${t.category}\n${t.reason}\n\nYou have the final say. Tap below if you still want a draft.`;
    if (dry) console.log('\n' + msg); else await send(msg, { reply_to_message_id: replyTo, ...buttons(id, [[['✍️ Draft anyway', 'f']]]) });
    return { t };
  }

  const news = await fetchNews(t.keywords || []);
  const d = await draft(note, t, news, rec.previous ? { redo: true, previous: rec.previous } : {});
  const flagged = unsourcedNumbers(d.post, note, news);
  Object.assign(rec, { news, draft: d, status: 'awaiting_review', previous: d.post });
  await store?.saveNote(id, rec);
  await store?.log('drafted', { id, score: t.score, words: d.post.split(/\s+/).length, flagged: flagged.length, headline: d.headline_used });

  const used = Number.isInteger(d.headline_used) ? news[d.headline_used] : null;
  const card = [
    `📝 DRAFT FOR REVIEW · score ${t.score}/10 · ${t.category}`,
    `Angle: ${t.angle}`,
    d.note_to_meera ? `Note: ${d.note_to_meera}` : '',
    used ? `\n📰 News hook used [VERIFY before posting]:\n${used.title} (${used.source}, ${used.date})\n${used.link}` : '\n📰 No news hook used.',
    news.length && !used ? `Other headlines found:\n${news.map(n => `• ${n.title} (${n.source}) ${n.link}`).join('\n')}` : '',
    d.claims_to_verify?.length ? `\n🔍 Check these claims:\n${d.claims_to_verify.map(c => `• ${c}`).join('\n')}` : '',
    flagged.length ? `\n⚠️ Numbers not found in your note or the headline: ${flagged.join(', ')}. Confirm or delete.` : '',
    '\nNothing is posted until you publish on LinkedIn yourself.',
  ].filter(Boolean).join('\n');

  if (dry) {
    console.log('\n' + '='.repeat(70) + '\n' + d.post + '\n' + '-'.repeat(70) + '\n' + card);
  } else {
    const m = await send(d.post, { reply_to_message_id: replyTo });
    await send(card, { reply_to_message_id: m.message_id, ...buttons(id, [[['✅ Use', 'a'], ['🔁 Redo', 'r'], ['❌ Skip', 's']]]) });
  }
  return { t, d, news, flagged };
}

async function onCallback(q, store) {
  const [action, id] = (q.data || '').split(':');
  const rec = await store.getNote(id);
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: rec ? 'Got it' : 'Note not found' }).catch(() => {});
  if (!rec) return;
  const msg = q.message;
  const done = (text) => tg('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } })
    .then(() => sendTo(msg.chat.id, text, { reply_to_message_id: msg.message_id }));

  if (action === 'a') { rec.status = 'approved'; await store.saveNote(id, rec); await store.log('approved', { id }); await done('✅ Marked as used. Copy the draft above, make your edits, and post it on LinkedIn.'); }
  if (action === 's') { rec.status = 'skipped'; await store.saveNote(id, rec); await store.log('skipped', { id }); await done('❌ Skipped.'); }
  if (action === 'r' || action === 'f') {
    await store.log(action === 'r' ? 'redo' : 'forced', { id });
    await done(action === 'r' ? '🔁 Redrafting with a different angle...' : '✍️ Drafting...');
    await processNote(rec.note, { id, replyTo: msg.message_id, store, force: true, chatId: msg.chat.id });
  }
}

// One Telegram update, from polling or from the webhook. Same flow for a private DM and a channel post.
async function handleUpdate(u, store) {
  const errChat = u.message?.chat.id || u.callback_query?.message?.chat.id || CHAT_ID;
  const mine = (chatId) => (CHAT_ID && String(chatId) === CHAT_ID) || (OWNER_ID && String(chatId) === OWNER_ID);
  try {
    const m = u.message?.chat.type === 'private' ? u.message
      : (u.channel_post && CHAT_ID && String(u.channel_post.chat.id) === CHAT_ID) ? u.channel_post : null;
    if (m) {
      if (m.chat.type === 'private' && (!OWNER_ID || String(m.from.id) !== OWNER_ID)) {
        await sendTo(m.chat.id, OWNER_ID ? 'This bot is private.' : `Your Telegram user ID is ${m.from.id}.\nSet TELEGRAM_OWNER_ID=${m.from.id} and restart/redeploy. Then send me any note or prompt.`);
        return;
      }
      let text = m.text || m.caption || '';
      if (text.startsWith('/')) { await sendTo(m.chat.id, 'Send me a text or voice note and I\'ll score it, find a news hook, and draft a LinkedIn post in Meera\'s voice.'); return; }
      await tg('sendChatAction', { chat_id: m.chat.id, action: 'typing' }).catch(() => {});
      const audio = m.voice || m.audio;
      if (audio) {
        text = await transcribe(audio);
        await sendTo(m.chat.id, `🎙 Transcribed:\n${text}`, { reply_to_message_id: m.message_id });
      }
      if (!text) return;
      const id = `${m.chat.type === 'private' ? 'd' : 'c'}${m.message_id}`;
      console.log(`📥 ${audio ? 'Voice' : 'Text'} note ${id}: ${text.slice(0, 80)}...`);
      const r = await processNote(text, { id, replyTo: m.message_id, store, chatId: m.chat.id });
      console.log(`   score ${r.t.score}/10 -> ${r.d ? 'drafted' : 'rejected'}`);
    } else if (u.callback_query && mine(u.callback_query.message?.chat.id)) {
      await onCallback(u.callback_query, store);
    }
  } catch (e) {
    console.error('Error:', e.message);
    await sendTo(errChat, `⚠️ Pipeline error: ${e.message.slice(0, 300)}`).catch(() => {});
  }
}

module.exports = { triage, draft, transcribe, fetchNews, processNote, handleUpdate, tg, sendTo, unsourcedNumbers, CHAT_ID, OWNER_ID, MODEL, MIN_SCORE };
