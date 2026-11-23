@echo off
echo ================================================
echo  Business Manager POS - Installation
echo ================================================
echo.

REM Check Node.js
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERREUR] Node.js n'est pas installe!
    echo Telechargez-le sur: https://nodejs.org
    pause
    exit /b 1
)

echo [OK] Node.js detecte
echo.

REM Install dependencies
echo Installation des dependances...
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo [ERREUR] Echec de l'installation des dependances.
    pause
    exit /b 1
)

echo.
echo [OK] Installation terminee!
echo.
echo Pour lancer l'application: npm start
echo Pour construire l'installateur: npm run build
echo.
pause
