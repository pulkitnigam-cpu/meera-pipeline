// Vercel webhook: Telegram POSTs every update here.
// We answer 200 immediately (so Telegram doesn't retry) and finish the 15-30s draft in the background via waitUntil.
const { waitUntil } = require('@vercel/functions');
const { handleUpdate } = require('../lib/core');
const store = require('../lib/redis-store');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Meera pipeline webhook is up.');

  // Only Telegram knows this secret (set via setWebhook), so random POSTs are ignored.
  if (process.env.WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET)
    return res.status(401).send('bad secret');

  const u = req.body || {};
  if (u.update_id !== undefined && !(await store.claimUpdate(u.update_id))) return res.status(200).send('duplicate');

  waitUntil(handleUpdate(u, store));
  res.status(200).send('ok');
};
