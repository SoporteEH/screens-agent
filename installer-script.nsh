!macro customInit
  nsExec::Exec 'taskkill /F /IM screens-web-agent.exe /T'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM screens-web-agent.exe /T'
!macroend
