@echo off
echo ========================================
echo   تطبيق تعديلات قاعدة البيانات (Postgres)
echo ========================================
echo.
echo هينسخ 4 ملفات فوق المشروع الحالي:
echo   - server.js
echo   - server\db.js
echo   - server\api.js
echo   - package.json
echo.
pause
copy /Y "%~dp0server.js" "server.js"
copy /Y "%~dp0server\db.js" "server\db.js"
copy /Y "%~dp0server\api.js" "server\api.js"
copy /Y "%~dp0package.json" "package.json"
echo.
echo ========================================
echo   تم! دلوقتي شغّل update.bat عشان ترفع التعديلات.
echo ========================================
pause
