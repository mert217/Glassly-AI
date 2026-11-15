---
name: kod-inceleme
description: "Kod incelemesi, PR değerlendirmesi ya da 'bu kodda sorun var mı' sorusunda: bulguları önem sırasına göre raporla"
---

# Kod inceleme

İncelenecek kodu baştan sona oku; tahmin yürütme, dosyaları aç.

Bulguları dört seviyede grupla:

- **Kritik** — veri kaybı, güvenlik açığı, çökme, yanlış sonuç.
- **Önemli** — yarış durumu, hata yönetimi eksikliği, performans darboğazı.
- **Öneri** — okunabilirlik, isimlendirme, tekrar eden kod.
- **Not** — zevk meselesi; isteğe bağlı.

Her bulgu için: dosya ve satır, sorunun kısa açıklaması, neden önemli olduğu ve somut bir düzeltme önerisi (mümkünse küçük bir kod parçasıyla).

Sorun bulamazsan bunu açıkça söyle ve neleri kontrol ettiğini listele. Kullanıcı istemedikçe dosyaları değiştirme.
