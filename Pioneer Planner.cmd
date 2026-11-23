@echo off
rem Double-click to open Pioneer Planner. First time: it checks Node.js, installs what it needs and offers a Desktop shortcut.
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\start.ps1"
