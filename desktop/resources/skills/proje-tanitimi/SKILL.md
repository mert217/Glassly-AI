---
name: proje-tanitimi
description: "Yeni bir projeyi tanıma, 'bu proje ne yapıyor' ya da mimari özeti istendiğinde: yapıyı keşfet ve kısa bir harita çıkar"
---

# Proje tanıtımı

1. Kök klasörü listele; README, paket dosyalarını (package.json, pyproject.toml, Cargo.toml, go.mod, *.pro, CMakeLists.txt) oku.
2. Giriş noktalarını bul (main, index, app, server) ve oradan önemli modüllere doğru ilerle.
3. Şu başlıklarla kısa bir özet ver:
   - **Ne yapıyor** — tek paragraf.
   - **Teknoloji** — dil, çatı, önemli bağımlılıklar.
   - **Yapı** — klasör → sorumluluk tablosu.
   - **Nasıl çalıştırılır** — kurulum, geliştirme ve test komutları.
   - **Dikkat çekenler** — eksik testler, eski bağımlılıklar, TODO'lar.
4. Uzun dosya içeriklerini aynen kopyalama; özetle ve dosya yolunu göster.
