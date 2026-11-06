@echo off

cd /d "%~dp0"

python make.py

echo 종료 코드: %errorlevel%

pause