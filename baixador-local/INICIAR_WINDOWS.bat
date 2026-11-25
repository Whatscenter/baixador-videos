@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Instale o Python em https://www.python.org/downloads/ marcando "Add Python to PATH" & pause & exit /b)
echo Atualizando o yt-dlp...
python -m pip install -U -q yt-dlp
python baixar_videos.py
pause
