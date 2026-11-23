!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  StrCpy $isForceMachineInstall "0"
!macroend

; After installation, add firewall exception for mobile server
!macro customInstall
  ; Allow the app through Windows Firewall (for mobile server on port 3030)
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Business Manager POS" dir=in action=allow program="$INSTDIR\Business Manager POS.exe" enable=yes profile=private'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Business Manager POS" dir=out action=allow program="$INSTDIR\Business Manager POS.exe" enable=yes profile=private'
!macroend

; Clean up firewall rules on uninstall
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Business Manager POS"'
!macroend
