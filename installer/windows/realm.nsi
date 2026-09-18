; REALM Windows x64 unsigned preview installer（NSIS 3.x Modern UI 2）。
; 无签名证书首发：如实标记 unsigned preview，不伪造签名。
; 数据目录 %LOCALAPPDATA%\REALM 默认在卸载时保留（明确提示）。

!define APP_NAME "REALM"
!define APP_VERSION "0.1.0-preview"
!define APP_PUBLISHER "REALM Maintainers"
!define BUNDLE_DIR "${__FILEDIR__}\..\..\bundle\REALM"

!include "MUI2.nsh"

Name "${APP_NAME} ${APP_VERSION} (unsigned preview)"
OutFile "realm-${APP_VERSION}-win-x64-unsigned.exe"
Unicode true
InstallDir "$PROGRAMFILES64\REALM"
InstallDirRegKey HKLM "Software\REALM" "InstallDir"
RequestExecutionLevel admin

!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${BUNDLE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\REALM" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\REALM" \
    "DisplayName" "REALM ${APP_VERSION} (unsigned preview)"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\REALM" \
    "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\REALM" \
    "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\REALM" \
    "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\REALM"
  CreateShortcut "$SMPROGRAMS\REALM\REALM.lnk" \
    "$INSTDIR\runtime\node\win-x64\node.exe" \
    '"$INSTDIR\launcher\realm-launcher.mjs"'
  CreateShortcut "$DESKTOP\REALM.lnk" \
    "$INSTDIR\runtime\node\win-x64\node.exe" \
    '"$INSTDIR\launcher\realm-launcher.mjs"'
SectionEnd

Section "Uninstall"
  ; 数据目录默认保留（用户世界/设置/日志），卸载前明确提示。
  MessageBox MB_ICONINFORMATION|MB_OK \
    "REALM will remove the application files only.$\r$\nYour worlds and settings in %LOCALAPPDATA%\REALM are kept. Delete that folder manually if you want a full removal."

  Delete "$DESKTOP\REALM.lnk"
  Delete "$SMPROGRAMS\REALM\REALM.lnk"
  RMDir "$SMPROGRAMS\REALM"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\REALM"
  DeleteRegKey HKLM "Software\REALM"
SectionEnd
