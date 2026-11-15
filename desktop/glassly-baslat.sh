#!/usr/bin/env bash
# Linux / macOS: çift tıkla ya da terminalde ./glassly-baslat.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js bulunamadı. Kurmak için (Ubuntu/Debian):"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi
# Paketler yoksa ya da package.json değiştiyse (yeni sürüm eski klasörün üstüne açıldıysa) kur
STAMP=node_modules/.glassly-paketler
SUM="$(cksum package.json | cut -d' ' -f1)"
if [ ! -d node_modules/electron/dist ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$SUM" ]; then
  echo "Paketler kuruluyor ya da güncelleniyor, birkaç dakika sürebilir..."
  npm install || { echo "Paketler kurulamadı. İnternet bağlantını kontrol et."; exit 1; }
  [ -d node_modules/electron/dist ] || node node_modules/electron/install.js || { echo "Electron indirilemedi. İnternet bağlantını kontrol et."; exit 1; }
  echo "$SUM" > "$STAMP"
fi
EXTRA=""
if [ "$(uname)" = "Linux" ]; then
  SB=node_modules/electron/dist/chrome-sandbox
  # Ubuntu 23.10+ AppArmor kısıtı ya da chrome-sandbox izni yoksa Electron açılmaz
  if [ -f "$SB" ] && ! { [ "$(stat -c %u "$SB")" = "0" ] && [ -u "$SB" ]; }; then
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then
      echo "Not: Electron korumalı alanı için izin gerekiyor. Kalıcı çözüm (bir kez):"
      echo "  sudo chown root:root $SB && sudo chmod 4755 $SB"
      echo "Şimdilik korumalı alan olmadan açılıyor..."
      EXTRA="--no-sandbox"
    fi
  fi
fi
npm start -- $EXTRA
