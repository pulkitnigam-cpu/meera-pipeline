// Vercel webhook: Telegram POSTs every update here.
// We answer 200 immediately (so Telegram doesn't retry) and finish the 15-30s draft in the background via waitUntil.
const { waitUntil } = require('@vercel/functions');
const { handleUpdate } = require('../lib/core');
const store = require('../lib/redis-store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    // Health check that also reports which settings Vercel can see (names only, never values).
    const need = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'GEMINI_API_KEY', 'WEBHOOK_SECRET'];
    const missing = need.filter(k => !process.env[k]);
    if (!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)) missing.push('Redis (connect Upstash in Storage)');
    return res.status(200).send(`Meera pipeline webhook is up. ${missing.length ? 'Missing: ' + missing.join(', ') : 'All settings present.'}`);
  }

  // Only Telegram knows this secret (set via setWebhook), so random POSTs are ignored. Fail closed if it isn't configured.
  if (!process.env.WEBHOOK_SECRET) return res.status(500).send('WEBHOOK_SECRET not configured in Vercel');
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) return res.status(401).send('bad secret');

  const u = req.body || {};
  if (u.update_id !== undefined && !(await store.claimUpdate(u.update_id))) return res.status(200).send('duplicate');

  waitUntil(handleUpdate(u, store));
  res.status(200).send('ok');
};
