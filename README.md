# Glassly Bulut — Cloudflare sürümü

Glassly için hesaplar (kayıt/giriş, misafir hakkı) ve OpenAI uyumlu model havuzu. GitHub'a yükle, Cloudflare'e bağla, çalışsın.

## Kurulum (GitHub → Cloudflare)

1. Bu klasörün **içindekileri** (package.json, wrangler.jsonc, src/ ...) yeni bir GitHub deposunun kök dizinine yükle.
2. Cloudflare paneli → **Workers & Pages** → **Create** → **Import a repository** (Workers) → GitHub'ı bağla, depoyu seç.
   - Build command: boş bırak
   - Deploy command: `npx wrangler deploy` (varsayılan)
3. **Deploy**'a bas. İlk yayında `DB` adlı KV alanı otomatik oluşturulur.
4. **Anahtar şart değil.** Anahtarsız çalışanlar: `cloudflare` (Workers AI, günlük ücretsiz kota), `ovh`, `kilo`, `llm7`, `pollinations`. Daha fazlası için aşağıdaki ücretsiz anahtarları (kart gerekmez) Worker → **Settings → Variables and Secrets** → **Secret** olarak ekle; eklemediğin sağlayıcı sessizce atlanır:

   | Secret adı | Sağlayıcı | Alınacağı yer |
   | --- | --- | --- |
   | `GROQ_KEY` | Groq | console.groq.com |
   | `GEMINI_KEY_1`, `GEMINI_KEY_2` | Google Gemini | aistudio.google.com |
   | `OPENROUTER_KEY` | OpenRouter (:free modeller) | openrouter.ai |
   | `CEREBRAS_KEY` | Cerebras | cloud.cerebras.ai |
   | `MISTRAL_KEY` | Mistral | console.mistral.ai |
   | `NVIDIA_KEY` | NVIDIA NIM | build.nvidia.com |
   | `HF_TOKEN` | Hugging Face | huggingface.co/settings/tokens |
   | `OLLAMA_KEY` | Ollama Cloud | ollama.com |
   | `SAMBANOVA_KEY` | SambaNova | cloud.sambanova.ai |
   | `ZAI_KEY` | Z.ai (GLM) | z.ai |
   | `COHERE_KEY` | Cohere (deneme anahtarı) | dashboard.cohere.com |
   | `DEEPSEEK_KEY` | DeepSeek | platform.deepseek.com (kullanım ücretli olabilir) |

   `config.json` içinde `"discover": true` olan sağlayıcıların model listesi ilk istekte `/models` adresinden otomatik çekilir (6 saatte bir yenilenir), model adları eskirse elle düzeltmek gerekmez.
5. Kontrol: `https://glassly-bulut.<hesabın>.workers.dev/health` → `{"ok":true,...}`
6. İstersen **Settings → Domains & Routes** ile `api.glassly.biz` gibi kendi alan adını bağla.

## Glassly uygulamasına tanıtma

Masaüstü uygulamanın `resources/cloud.json` dosyasına adresini yaz:

```json
{ "name": "Glassly Bulut", "url": "https://glassly-bulut.HESABIN.workers.dev/v1", "key": "" }
```

## Ayarlar (hepsi isteğe bağlı, Variables bölümünden)

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `GLASSLY_GUEST_LIMIT` | `1` | Hesap açmadan kullanılabilecek toplam mesaj hakkı (hakkı bitince giriş/kayıt istenir) |
| `GLASSLY_DAILY_LIMIT` | `50` | Hesap açan kullanıcının günlük mesaj kotası (UTC gece yarısı sıfırlanır); `0` = sınırsız |
| `GLASSLY_GUEST_IP_DAILY` | `40` | Aynı IP'den günlük misafir mesajı |
| `GLASSLY_SESSION_DAYS` | `90` | Oturum süresi |
| `GLASSLY_REQUIRE_AUTH` | `true` | `false` olursa bulut modelleri herkese açılır |
| `GLASSLY_ACCESS_KEYS` | yok | Virgüllü erişim anahtarları |
| `GLASSLY_CONFIG_JSON` | yok | `src/config.json` yerine tüm yapılandırma (model listesi) |
| `GLASSLY_PBKDF2_ITER` | `100000` | Şifre özet turu (en çok 100000) |

Modelleri değiştirmek için `src/config.json` dosyasını düzenleyip GitHub'a yükle; Cloudflare kendiliğinden yeniden yayınlar.

## Takılmaya karşı

- Bir sağlayıcı 9 sn (akışlı) / 20 sn (akışsız) içinde ilk yanıtı vermezse beklemeden sıradakine geçilir (`timeoutStreamMs`, `timeoutPlainMs`); bir isteğin toplam bütçesi 45 sn'dir (`budgetMs`).
- Modeli artık olmayan sağlayıcılar (404, "model not found") 6 saatliğine devre dışı bırakılır; limit dolanlar kısa süre soğumaya alınır.
- `auto` modunda önce iyi katman (anahtarlı sağlayıcılar), sonra anahtarsız büyük modeller, en son küçük modeller denenir.

## Önemli notlar

- Bu sürüm eski GoDaddy sürümündeki hesapları taşımaz (şifre algoritması farklı); kullanıcılar yeniden kayıt olur.
- Hesaplar KV'de durur. KV "eventual consistency" olduğu için aynı anda gelen çok hızlı istekler misafir sayacını birkaç mesaj şaşırtabilir; sorun değil.
- Şifre özeti (PBKDF2) Cloudflare ücretsiz planda CPU sınırına takılırsa giriş/kayıt hata verebilir. O zaman `GLASSLY_PBKDF2_ITER` değerini düşür ya da Workers Paid planına geç.

## Uç noktalar

`GET /health`, `GET /v1/models`, `POST /v1/chat/completions`, `POST /auth/register`, `/auth/login`, `GET /auth/me`, `POST /auth/logout`, `/auth/update`, `/auth/password`, `/auth/delete`, `/auth/guest`, `/auth/guest/use`
