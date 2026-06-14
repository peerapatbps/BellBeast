@echo off
echo =========================================
echo  Open Firewall Port 443 (ASP.NET)
echo =========================================

REM ตรวจสอบสิทธิ์ Admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Please run this file as Administrator.
    echo.
    pause
    exit /b
)

REM เพิ่ม Inbound Rule
netsh advfirewall firewall add rule ^
    name="BellBeast ASP.NET 443" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=443 ^
    profile=private,domain

echo.
echo Firewall rule added successfully.
echo Port 443 is now OPEN.
echo.
pause
