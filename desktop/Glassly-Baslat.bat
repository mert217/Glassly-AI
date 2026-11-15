@echo off
chcp 65001 >nul
title Glassly
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js bulunamadi.
  echo  https://nodejs.org adresinden LTS surumunu indirip kur, sonra bu dosyaya tekrar cift tikla.
  echo.
  start "" "https://nodejs.org/tr/download"
  pause
  exit /b 1
)
set "SUM="
for /f "skip=1 delims=" %%h in ('certutil -hashfile package.json MD5') do if not defined SUM set "SUM=%%h"
set "OLD="
if exist "node_modules\.glassly-paketler" set /p OLD=<"node_modules\.glassly-paketler"
if not exist "node_modules\electron\dist" set "OLD=yok"
if not "%OLD%"=="%SUM%" (
  echo  Paketler kuruluyor ya da guncelleniyor, birkac dakika surebilir...
  call npm install
  if errorlevel 1 (
    echo  Paketler kurulamadi. Internet baglantini kontrol edip tekrar dene.
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist" call node node_modules\electron\install.js
  >"node_modules\.glassly-paketler" echo %SUM%
)
echo  Glassly aciliyor...
call npm start
