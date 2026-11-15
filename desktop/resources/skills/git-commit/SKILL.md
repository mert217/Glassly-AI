---
name: git-commit
description: "Commit mesajı yazılması ya da değişikliklerin commit'lenmesi istendiğinde: Conventional Commits biçiminde anlamlı mesaj üret"
---

# Commit mesajı

1. `git status` ve `git diff --staged` (staged yoksa `git diff`) ile değişiklikleri incele.
2. Değişikliğin türünü seç: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`, `build`, `ci`.
3. Kapsam ekle (isteğe bağlı): `feat(auth): ...`
4. Başlık en fazla 72 karakter, emir kipinde, sonda nokta yok.
5. Gövdede "ne" yerine "neden" değiştiğini anlat; satırları 72 karakterde kır.
6. Kırıcı değişiklik varsa `BREAKING CHANGE:` satırı ekle.
7. Kullanıcı açıkça istemedikçe `git push` yapma.

Örnek:

```
fix(api): oturum süresi dolunca boş yanıt dönmesini engelle

Token yenilenirken eski istek kuyrukta kalıyordu; artık yenileme
bitene kadar bekletilip tekrar gönderiliyor.
```
