!macro customInit
  ; Cierra las instancias de la aplicación antes de instalar
  ${nsProcess::FindProcess} "local-agent.exe" $R0
  ${If} $R0 == 0
    DetailPrint "Cerrando instancias existentes de ScreensWeb Agent..."
    ${nsProcess::KillProcess} "local-agent.exe" $R0
    Sleep 2000
  ${EndIf}
  ${nsProcess::Unload}
!macroend

!macro customUnInit
  ; Cierra todas las instancias antes de desinstalar
  ${nsProcess::FindProcess} "local-agent.exe" $R0
  ${If} $R0 == 0
    DetailPrint "Cerrando ScreensWeb Agent..."
    ${nsProcess::KillProcess} "local-agent.exe" $R0
    Sleep 2000
  ${EndIf}
  ${nsProcess::Unload}
!macroend
