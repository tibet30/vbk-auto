!macro customInstall
  # Launch the installed executable directly from the finish page.
  # Some Windows environments fail ShellExecute on Start Menu .lnk files.
  StrCpy $launchLink "$appExe"
!macroend
