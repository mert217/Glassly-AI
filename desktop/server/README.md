# Glassly Bulut

Glassly kullanıcılarına anahtarsız, kesintisiz model sunmak için kendi sunucunda (ör. `api.glaslly.biz`) çalıştıracağın küçük bir ara sunucu. Bağımlılığı yok, Node.js 18+ yeterli.

## Ne yapar

- Birden çok sağlayıcıyı (Gemini, Groq, OpenRouter, Cerebras ya da OpenAI uyumlu herhangi biri) ve her birinin birden çok anahtarını tek bir havuzda toplar.
- `auto` modeli istekleri havuzdaki modeller arasında sırayla dağıtır.
- Bir anahtar ya da model limite takılırsa (429, kota, kredi bitti) onu bir süre soğumaya alır ve aynı isteği hemen sıradakine gönderir. Kullanıcı bunu fark etmez.
- Akışlı (stream) yanıtları olduğu gibi aktarır.
- IP başına dakika sınırı ve isteğe bağlı erişim anahtarları ile senin anahtarlarını kötüye kullanıma karşı korur.

Havuzdaki her sağlayıcının kendi kotası vardır; Glassly Bulut bunları sırayla kullanarak kesintiyi ortadan kaldırır. Ne kadar çok sağlayıcı ve anahtar eklersen o kadar "sınırsız" olur. Anahtarları her sağlayıcının kullanım koşullarına uygun şekilde edin.

## Kurulum

```bash
cd server
cp config.example.json config.json   # sağlayıcıları ve modelleri düzenle
export GEMINI_KEY_1=...  GROQ_KEY=...  OPENROUTER_KEY=...  CEREBRAS_KEY=...
node index.js
```

`config.json` içinde anahtarı doğrudan yazabilir ya da `"$ORTAM_DEGISKENI"` biçiminde ortam değişkeninden okutabilirsin. Model adlarını sağlayıcıların güncel listesinden kontrol et.

Docker ile:

```bash
docker build -t glassly-cloud .
docker run -d --restart=always -p 8787:8787 --env-file .env glassly-cloud
```

## Alan adına bağlama (HTTPS)

Caddy kullanıyorsan `Caddyfile`:

```
api.glaslly.biz {
  reverse_proxy 127.0.0.1:8787
}
```

Kontrol: `https://api.glaslly.biz/health` adresi `{"ok":true,...}` döndürmeli.

## Glassly'ye tanıtma

Uygulamayı paketlemeden önce `resources/cloud.json` dosyasına adresini yaz; böylece indiren herkes kurulumsuz kullanır:

```json
{ "name": "Glassly Bulut", "url": "https://api.glaslly.biz/v1", "key": "" }
```

`accessKeys` kullanıyorsan anahtarı `key` alanına yaz. Kullanıcılar adresi Ayarlar → Modeller bölümünden de değiştirebilir.

## Uç noktalar

| Yol | Açıklama |
| --- | --- |
| `GET /health` | Durum ve hazır yuva sayısı |
| `GET /v1/models` | `auto` + havuzdaki modeller |
| `POST /v1/chat/completions` | OpenAI uyumlu sohbet (stream destekli) |


## Hesaplar

`"accounts": true` (varsayılan) iken modelleri yalnızca Glassly'de hesap açıp giriş yapanlar kullanır. Uygulama, sunucu ayarlıysa kaydı ve girişi otomatik olarak buraya yapar.

- Kullanıcılar `data/users.json` dosyasında tutulur (`GLASSLY_USERS` ile değiştirilebilir). Şifreler scrypt ile özetlenir; oturum belirteçlerinin yalnızca SHA-256 özeti saklanır.
- `"registration": false` yeni kaydı kapatır.
- `"googleClientIds"`: Google ile girişte kabul edilecek OAuth istemci kimlikleri (uygulamaya gömdüğün `client_id`). Boş bırakılırsa her geçerli Google girişi kabul edilir.
- `"sessionDays"`: oturum süresi (gün, varsayılan 90).
- Uç noktalar: `POST /auth/register`, `POST /auth/login`, `POST /auth/google`, `GET|PATCH|DELETE /auth/me`, `POST /auth/password`, `POST /auth/logout`. Giriş denemeleri IP başına dakikada 15 ile sınırlıdır.
- Docker'da `data/` klasörünü kalıcı bir birime bağla, yoksa konteyner yenilenince hesaplar silinir: `-v glassly-data:/app/data`.

## Geliştirici hesabı

`config.json` içindeki `developer` alanı sunucu açılırken geliştirici hesabını hazırlar (şifre yalnızca scrypt özeti olarak durur). `admins` listesine yazılan e-postalar da geliştirici sayılır. Geliştiriciler:

- `GET /admin/users`, `DELETE /admin/users/:id`, `GET /admin/stats`, `POST /admin/settings {"registration": true|false}` uç noktalarını kullanabilir,
- hız sınırına takılmaz,
- silinemez.

Uygulamada Ayarlar → Geliştirici sekmesi yalnızca bu hesaplarda görünür.

## Günlük mesaj sınırı

Her hesap günde `dailyMessages` (varsayılan 70) mesaj gönderebilir; `0` yazarsan sınır kalkar. Gün `timezone` saatine göre gece yarısı yenilenir. Geliştirici hesapları sınırsızdır.
