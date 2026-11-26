@echo off
rem GiGoGi Phone Control launcher
cd /d "%~dp0"
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw "%~dp0phone_control.py"
) else (
  start "" python "%~dp0phone_control.py"
)
