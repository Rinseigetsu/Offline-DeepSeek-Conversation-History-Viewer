@echo off
rem Serve this folder on http://127.0.0.1:8777 and open it (clipboard API etc.
rem only work on http, so this is the "nicer" way to read). Close the window to stop.
setlocal
cd /d "%~dp0"
set PORT=8777
echo Serving %CD% on http://127.0.0.1:%PORT%/index.html
echo Close this window to stop the server.
start "" "http://127.0.0.1:%PORT%/index.html"
where python >nul 2>nul && (python -m http.server %PORT% & goto :eof)
where py >nul 2>nul && (py -m http.server %PORT% & goto :eof)
echo Python not found - just double-click index.html instead.
pause
