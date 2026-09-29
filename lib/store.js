// Room storage in Redis.
//
// Each room is two keys:
//   rvb:room:<CODE>    -> JSON of the whole room (game + seats)
//   rvb:room:<CODE>:v  -> version number, bumped on every change
// Clients poll the small version key and only download the room when it changes.
// Writes are compare-and-set (a tiny Lua script), so two players acting at the
// same moment can never overwrite each other.
//
// Works with whichever Redis you connect in Vercel:
//   • Upstash (REST)  — KV_REST_API_URL + KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL/TOKEN)
//   • Any Redis URL   — REDIS_URL (or KV_URL), e.g. Redis Cloud
//   • Nothing set     — in-memory store, for local testing only

const TTL_SECONDS = 60 * 60 * 24 * 14; // rooms expire 14 days after their last change

const CAS_SCRIPT = `
local v = redis.call('GET', KEYS[2])
if (v or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
return 1`;

const keys = code => [`rvb:room:${code}`, `rvb:room:${code}:v`];

let storePromise = null;
export function getStore() {
  if (!storePromise) storePromise = makeStore().catch(err => { storePromise = null; throw err; });
  return storePromise;
}

async function makeStore() {
  const env = process.env;

  const restUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) {
    const { Redis } = await import('@upstash/redis');
    const r = new Redis({ url: restUrl, token: restToken, automaticDeserialization: false });
    return wrap('upstash', {
      get: k => r.get(k),
      mget: (a, b) => r.mget(a, b),
      cas: (ks, args) => r.eval(CAS_SCRIPT, ks, args),
    });
  }

  const url = env.REDIS_URL || env.KV_URL;
  if (url) {
    const { createClient } = await import('redis');
    const c = createClient({ url });
    c.on('error', e => console.error('[red-vs-blue] Redis error:', e.message));
    await c.connect();
    return wrap('redis', {
      get: k => c.get(k),
      mget: (a, b) => c.mGet([a, b]),
      cas: (ks, args) => c.eval(CAS_SCRIPT, { keys: ks, arguments: args }),
    });
  }

  if (env.VERCEL) {
    throw new Error('No Redis database is connected. In your Vercel project open Storage, add a Redis database (e.g. Upstash for Redis), connect it to this project, then redeploy.');
  }
  console.warn('[red-vs-blue] No Redis environment variables found — using an in-memory store (local testing only).');
  const m = new Map();
  return wrap('memory', {
    get: async k => m.get(k) ?? null,
    mget: async (a, b) => [m.get(a) ?? null, m.get(b) ?? null],
    cas: async ([k1, k2], [expect, json, nv]) => {
      if ((m.get(k2) ?? '') !== expect) return 0;
      m.set(k1, json); m.set(k2, nv);
      return 1;
    },
  });
}

function wrap(kind, r) {
  return {
    kind,
    async getVersion(code) {
      const v = await r.get(keys(code)[1]);
      return v == null ? null : Number(v);
    },
    async read(code) {
      const [json, v] = await r.mget(...keys(code));
      if (json == null || v == null) return null;
      return { json: typeof json === 'string' ? json : JSON.stringify(json), version: Number(v) };
    },
    // Write only if the stored version still equals `expect` ('' = room must not exist yet).
    async cas(code, expect, json, newVersion) {
      const res = await r.cas(keys(code), [String(expect), json, String(newVersion), String(TTL_SECONDS)]);
      return Number(res) === 1;
    },
  };
}
