// Glassly Bulut veri katmanı: Cloudflare KV üstünde basit anahtar/değer deposu.
// Anahtar biçimi: "<koleksiyon>:<id>"  (ör. users:ali@ornek.com, sessions:<özet>)

export function openDB(kv) {
  const k = (c, id) => `${c}:${id}`;
  return {
    async get(c, id) { return (await kv.get(k(c, id), 'json')) ?? null; },
    // ttl (sn): süresi dolunca KV kaydı kendisi siler (oturum, misafir IP sayacı)
    async put(c, id, v, ttl) {
      const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : undefined;
      await kv.put(k(c, id), JSON.stringify(v), opts);
    },
    async del(c, id) { await kv.delete(k(c, id)); },
    async count(c) {
      let n = 0, cursor;
      for (let i = 0; i < 10; i++) { // en çok 10.000 kayıt say
        const r = await kv.list({ prefix: `${c}:`, cursor });
        n += r.keys.length;
        if (r.list_complete) break;
        cursor = r.cursor;
      }
      return n;
    },
  };
}
