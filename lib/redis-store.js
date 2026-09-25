// Store backed by Upstash Redis (REST API, no SDK). Used on Vercel, where the filesystem doesn't persist.
// The Vercel "Upstash for Redis" integration sets KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 30; // keep notes 30 days

async function redis(...cmd) {
  if (!URL_ || !TOKEN) throw new Error('Redis not configured: connect Upstash for Redis to the Vercel project');
  const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await res.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

module.exports = {
  redis,
  async getNote(id) { const v = await redis('GET', `note:${id}`); return v ? JSON.parse(v) : null; },
  async saveNote(id, rec) { await redis('SET', `note:${id}`, JSON.stringify(rec), 'EX', TTL); },
  async log(event, data) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    console.log(line);
    await redis('LPUSH', 'log', line);
  },
  // Telegram retries a webhook it thinks failed; only handle each update once.
  async claimUpdate(updateId) { return (await redis('SET', `upd:${updateId}`, '1', 'NX', 'EX', 3600)) === 'OK'; },
};
