@echo off
rem REALM one-command installer entry for cmd.exe / double-click.
rem iex/irm are PowerShell-only; this bootstrap hands off to PowerShell.
rem For interactive use prefer: right-click Start menu -> Terminal (PowerShell).
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex \"& { $(irm 'https://raw.githubusercontent.com/Silver-Aurora/REALM/main/scripts/install.ps1') } -EmbeddedPg\""
if errorlevel 1 pause
