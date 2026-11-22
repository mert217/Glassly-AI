# Glassly akış düzeltmesi

- Giriş ekranı: e-posta ve Google giriş seçenekleri görünür.
- Sohbet: mesaj gönderilir, parçalar sırayla görünür, tek asistan mesajı kaydedilir.
- Uzun yanıt: token sınırında kalan yanıt otomatik devam eder.
- Kopan sağlayıcı: bitiş işareti gelmeyen akış başarı sayılmaz; devam denenir.
- Kullanıcı durdurması: otomatik devam başlatılmaz.
- Hata: kısmi yanıt saklanır, kesinti kullanıcıya bildirilir.
- Geçmiş: kayıtlı sohbet açılabilir.

Bu değişiklik hesap, dosya, görsel, arama ve hatırlatıcı API'lerini değiştirmez.

## API anahtarları
- Her kullanıcı Ayarlar > API bölümünde anahtar adı girer, oluşturur: tam anahtar bir kez görünür, kopyalanabilir.
- Paneli yenile: yalnızca anahtar öneki görünür; gizli değer tekrar gelmez.
- Kullanıcı yalnızca kendi anahtarını görebilir/iptal edebilir. API anahtarı hesap/admin API'lerine erişemez.
- Model listesi ve yanıtlar yalnızca Glassly adını gösterir.
- Hesap başına aynı dakikadaki üçüncü ve günlük on birinci istek 429 döner; paralel isteklerde de sınır korunur. Anahtarı değiştirmek kotayı yenilemez.
- Token sınırı 512, girdi sınırı 16000 karakter; yanlış istekler kotadan düşmez.
- İptal et: onaydan sonra anahtar bir daha kullanılamaz.
- Mevcut kullanıcı oturumuyla sohbet ve giriş etkilenmez.
