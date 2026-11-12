!include "nsDialogs.nsh"

!define QUIVER_BROWSER_KEY "Software\Clients\StartMenuInternet\Quiver"
!define QUIVER_CAPABILITIES_KEY "${QUIVER_BROWSER_KEY}\Capabilities"
!define QUIVER_URL_KEY "Software\Classes\Quiver.Url"
!define QUIVER_STARTUP_LINK "Quiver Browser.lnk"

!ifndef BUILD_UNINSTALLER
Var QuiverDefaultCheck
Var QuiverImportCheck
Var QuiverStartupCheck
Var QuiverDefaultSelected
Var QuiverImportSelected
Var QuiverStartupSelected
Var QuiverOptionsScope
Var QuiverPageIcon

!macro customInit
  Call QuiverReadStartupChoice
  StrCpy $QuiverDefaultSelected ${BST_UNCHECKED}
  StrCpy $QuiverImportSelected ${BST_UNCHECKED}
  ${If} ${Silent}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/STARTATLOGIN" $1
    ${IfNot} ${Errors}
    ${AndIf} $1 == ""
      StrCpy $QuiverStartupSelected ${BST_CHECKED}
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom QuiverOptionsPage QuiverSaveOptions

  Function QuiverReadStartupChoice
    StrCpy $QuiverOptionsScope $installMode
    StrCpy $QuiverStartupSelected ${BST_UNCHECKED}
    ${If} ${FileExists} "$SMSTARTUP\${QUIVER_STARTUP_LINK}"
      StrCpy $QuiverStartupSelected ${BST_CHECKED}
    ${EndIf}
  FunctionEnd

  Function QuiverOptionsPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $QuiverOptionsScope != $installMode
      Call QuiverReadStartupChoice
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Set up Quiver" "Choose how Quiver starts and what to bring with you."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 25u ""
    Pop $0
    SetCtlColors $0 0xF5F7FF 0x14161A
    ${NSD_CreateIcon} 3u 2u 23u 23u ""
    Pop $0
    # The pinned NSIS 3.0 compiler predates NSD_SetIconFromInstaller.
    System::Call 'kernel32::GetModuleHandleW(p 0)p.r3'
    System::Call 'user32::LoadImageW(p r3,p 103,i 1,i 32,i 32,i 0)p.s'
    Pop $QuiverPageIcon
    SendMessage $0 ${STM_SETICON} $QuiverPageIcon 0
    ${NSD_CreateLabel} 30u 7u 76% 12u "Quiver browser options"
    Pop $0
    SetCtlColors $0 0xAFC5FF 0x14161A

    ${NSD_CreateCheckbox} 1u 32u 99% 12u "Open Windows &Default Apps after setup"
    Pop $QuiverDefaultCheck
    ${NSD_SetState} $QuiverDefaultCheck $QuiverDefaultSelected
    ${NSD_CreateLabel} 13u 46u 94% 12u "Choose Quiver in Windows Settings."
    Pop $0
    ${NSD_CreateCheckbox} 1u 63u 99% 12u "&Import bookmarks from another browser"
    Pop $QuiverImportCheck
    ${NSD_SetState} $QuiverImportCheck $QuiverImportSelected
    ${NSD_CreateLabel} 13u 77u 94% 12u "Choose a browser profile or an HTML file in Quiver."
    Pop $0
    ${If} $installMode == "all"
      StrCpy $1 "Launch Quiver when &any user signs in"
    ${Else}
      StrCpy $1 "Launch Quiver when I &sign in"
    ${EndIf}
    ${NSD_CreateCheckbox} 1u 94u 99% 12u "$1"
    Pop $QuiverStartupCheck
    ${NSD_SetState} $QuiverStartupCheck $QuiverStartupSelected

    nsDialogs::Show
    ${If} $QuiverPageIcon != 0
      System::Call 'user32::DestroyIcon(p $QuiverPageIcon)'
    ${EndIf}
  FunctionEnd

  Function QuiverSaveOptions
    ${NSD_GetState} $QuiverDefaultCheck $QuiverDefaultSelected
    ${NSD_GetState} $QuiverImportCheck $QuiverImportSelected
    ${NSD_GetState} $QuiverStartupCheck $QuiverStartupSelected
  FunctionEnd
!macroend

!macro customFinishPage
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE QuiverFinishChoices
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION QuiverFinishOpenBrowser
  !insertmacro MUI_PAGE_FINISH

  Function QuiverFinishChoices
    ${If} ${RebootFlag}
      Return
    ${EndIf}
    ${If} $QuiverDefaultSelected == ${BST_CHECKED}
      StrCpy $1 "ms-settings:defaultapps"
      ReadRegStr $2 HKLM "Software\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
      ${If} $2 >= 22000
        ${If} $installMode == "all"
          StrCpy $1 "ms-settings:defaultapps?registeredAppMachine=Quiver"
        ${Else}
          StrCpy $1 "ms-settings:defaultapps?registeredAppUser=Quiver"
        ${EndIf}
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$1" "open" ""
    ${EndIf}
    ${If} $QuiverImportSelected == ${BST_CHECKED}
      ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" "--import-bookmarks"
    ${EndIf}
  FunctionEnd

  Function QuiverFinishOpenBrowser
    ${If} $QuiverImportSelected != ${BST_CHECKED}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
    ${EndIf}
  FunctionEnd
!macroend
!endif

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${QUIVER_BROWSER_KEY}" "" "Quiver"
  WriteRegStr SHELL_CONTEXT "${QUIVER_BROWSER_KEY}\DefaultIcon" "" '$\"$appExe$\",0'
  WriteRegStr SHELL_CONTEXT "${QUIVER_BROWSER_KEY}\shell\open\command" "" '$\"$appExe$\"'
  WriteRegStr SHELL_CONTEXT "${QUIVER_CAPABILITIES_KEY}" "ApplicationName" "Quiver"
  WriteRegStr SHELL_CONTEXT "${QUIVER_CAPABILITIES_KEY}" "ApplicationDescription" "Quiver web browser"
  WriteRegStr SHELL_CONTEXT "${QUIVER_CAPABILITIES_KEY}" "ApplicationIcon" '$\"$appExe$\",0'
  WriteRegStr SHELL_CONTEXT "${QUIVER_CAPABILITIES_KEY}\URLAssociations" "http" "Quiver.Url"
  WriteRegStr SHELL_CONTEXT "${QUIVER_CAPABILITIES_KEY}\URLAssociations" "https" "Quiver.Url"
  WriteRegStr SHELL_CONTEXT "${QUIVER_URL_KEY}" "" "Quiver web link"
  WriteRegStr SHELL_CONTEXT "${QUIVER_URL_KEY}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "${QUIVER_URL_KEY}\DefaultIcon" "" '$\"$appExe$\",0'
  WriteRegStr SHELL_CONTEXT "${QUIVER_URL_KEY}\shell\open\command" "" '$\"$appExe$\" -- $\"%1$\"'
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Quiver" "${QUIVER_CAPABILITIES_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000,i 0,p 0,p 0)'

  ${If} $QuiverStartupSelected == ${BST_CHECKED}
    CreateDirectory "$SMSTARTUP"
    ClearErrors
    CreateShortCut "$SMSTARTUP\${QUIVER_STARTUP_LINK}" "$appExe" "" "$appExe" 0
    ${If} ${Errors}
      DetailPrint "Quiver could not create the sign-in shortcut."
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Quiver installed, but could not create the sign-in shortcut."
      ${EndIf}
    ${EndIf}
  ${Else}
    Delete "$SMSTARTUP\${QUIVER_STARTUP_LINK}"
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
Function un.onUninstSuccess
  Delete "$SMSTARTUP\${QUIVER_STARTUP_LINK}"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Quiver"
  DeleteRegKey SHELL_CONTEXT "${QUIVER_BROWSER_KEY}"
  DeleteRegKey SHELL_CONTEXT "${QUIVER_URL_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000,i 0,p 0,p 0)'
FunctionEnd
!endif
