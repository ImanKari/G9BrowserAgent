; G9 installs per user, never per machine (docs/INSTALL.md: %LOCALAPPDATA%\Programs\G9, no admin).
; electron-builder's assisted installer (oneClick: false) would otherwise offer an
; "install for all users" page, which needs elevation. Forcing the current-user mode skips it.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
