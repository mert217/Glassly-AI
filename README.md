# Glassly — glassly.biz

Glassly'nin internetteki evi. Tek bir Cloudflare Worker şunların hepsini sunar:

- **Tanıtım sayfası** (`/`) — uygulama indirme bağlantılarıyla
- **Web uygulaması** (`/app/`) — tarayıcıdan sohbet, hesap, ayarlar, geliştirici paneli
- **Hesaplar** (`/auth/*`) — e-posta + şifre ya da Google; web ve masaüstü aynı hesabı kullanır
- **Glassly Bulut** (`/v1/*`) — masaüstü uygulamasının bağlandığı OpenAI uyumlu model havuzu
- Veriler **Cloudflare D1** veritabanında durur (ilk yayında kendiliğinden oluşur)

Masaüstü uygulamasının kaynak kodu `desktop/` klasöründedir. Yeni bir sürüm etiketi (`v0.2.0` gibi) gönderildiğinde GitHub Actions Windows, Linux ve macOS kurulum dosyalarını derleyip **Releases** sayfasına koyar; tanıtım sayfasındaki indirme düğmeleri her zaman en son sürümü gösterir.

## Yayına alma (GitHub → Cloudflare)

1. Cloudflare paneli → **Workers & Pages** → **Create application** → **Import a repository** → GitHub hesabını bağla → `Glassly-AI` deposunu seç.
   - Project name: `glassly-ai`
   - Build command: boş
   - Deploy command: `npx wrangler deploy`
   - **Create and deploy**'a bas.
2. Worker → **Settings** → **Variables and Secrets** → **Add** → Type: **Secret**
   - Name: `GLASSLY_DEVELOPER`
   - Value: `e-posta|şifre-özeti` (şifre özeti `node scripts/sifre-ozeti.mjs 'ŞİFREN'` ile üretilir)
   - **Deploy**'a bas.
3. Alan adı: Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain** → `glassly.biz` (aynısını `www.glassly.biz` için de yap). Alan adında eski DNS kaydı varsa önce **DNS → Records** bölümünden sil.
4. Kontrol: `https://glassly.biz/health` → `{"ok":true,...}`

Bundan sonra GitHub'a her gönderimde Cloudflare siteyi kendiliğinden yeniden yayınlar.

## Model kaynakları

Anahtar şart değil: `cloudflare` (Workers AI, günlük ücretsiz kota) ve anahtarsız sağlayıcılar kendiliğinden çalışır. Daha fazla kapasite için aşağıdaki ücretsiz anahtarları **Secret** olarak ekleyebilirsin; eklemediğin sağlayıcı sessizce atlanır.

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


## Ayarlar (`wrangler.jsonc` → `vars`, ya da panelden)

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `GLASSLY_DAILY_LIMIT` | `70` | Günlük mesaj hakkı (geliştirici sınırsız); `0` = herkes sınırsız |
| `GLASSLY_TIMEZONE` | `Europe/Istanbul` | Günlük hakkın sıfırlandığı saat dilimi |
| `GLASSLY_GOOGLE_CLIENT_IDS` | masaüstü istemcisi | Kabul edilen Google istemci kimlikleri (virgüllü) |
| `GLASSLY_GOOGLE_WEB_CLIENT_ID` | boş | Doluysa web uygulamasında "Google ile devam et" görünür (Google Cloud'da **Web application** türünde istemci, Authorized JavaScript origins: `https://glassly.biz`) |
| `GLASSLY_ADMINS` | boş | Ek geliştirici e-postaları (virgüllü) |
| `GLASSLY_REGISTRATION` | `true` | İlk açılışta kayıt açık mı (sonra geliştirici panelinden değiştirilir) |
| `GLASSLY_SESSION_DAYS` | `90` | Oturum süresi |
| `GLASSLY_PBKDF2_ITER` | `100000` | Yeni şifreler için özet turu; ücretsiz planda CPU sınırına takılırsa düşür |
| `GLASSLY_OPEN_PROXY` | `false` | `true` olursa `/v1` giriş yapmadan da kullanılabilir |
| `GLASSLY_CONFIG_JSON` | yok | `src/config.json` yerine tüm model yapılandırması |

## Yerelde deneme

```bash
npm install
npx wrangler dev
```

## Uç noktalar

- Hesap: `POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/logout`, `/auth/password` · `GET|PATCH|DELETE /auth/me` · `GET|POST /auth/usage`
- Geliştirici: `GET /admin/users`, `DELETE /admin/users/:id`, `GET /admin/stats`, `POST /admin/settings`
- Web: `GET /api/config`, `GET|DELETE /api/chats`, `GET|PATCH|DELETE /api/chats/:id`, `POST /api/chat` (akışlı)
- Bulut: `GET /v1/models`, `POST /v1/chat/completions`, `GET /health`
