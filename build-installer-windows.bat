@echo off
setlocal
cd /d "%~dp0"
title Bangun installer ORION (Windows)
echo ================================================
echo  ORION - bangun installer Windows (.exe)
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang. Pasang versi LTS dari https://nodejs.org lalu jalankan ulang berkas ini.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 18 (
  echo Node.js terlalu lama (butuh 18 atau lebih baru). Perbarui dari https://nodejs.org
  pause
  exit /b 1
)
echo.
echo [1/2] Memasang dependensi (butuh internet, beberapa menit)...
call npm install
if errorlevel 1 goto :fail
echo.
echo [2/2] Membangun installer...
call npm run dist:win
if errorlevel 1 goto :fail
echo.
echo SELESAI. Installer ada di folder dist\modern (berkas ORION-...-win-x64.exe).
echo Catatan: tanpa tanda tangan digital, Windows SmartScreen akan menampilkan peringatan: klik "More info" lalu "Run anyway".
explorer dist\modern
pause
exit /b 0
:fail
echo.
echo GAGAL. Periksa pesan error di atas (umumnya koneksi internet atau antivirus yang memblokir).
pause
exit /b 1
