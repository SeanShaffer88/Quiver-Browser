Unicode true
Name "Quiver Portable"
OutFile "${OUTPUT}"
Icon "${APP_ICON}"
RequestExecutionLevel user
SilentInstall silent

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; Permit missing paths, but reject reparse points and unexpected existing types.
!macro CheckDataPath PATH DIRECTORY_ATTRIBUTE
    System::Call 'Kernel32::GetFileAttributesW(w "${PATH}") i.r1 ?e'
    Pop $2
    ${If} $1 == -1
        ${If} $2 != 2 ; ERROR_FILE_NOT_FOUND
        ${AndIf} $2 != 3 ; ERROR_PATH_NOT_FOUND
            Goto profile_error
        ${EndIf}
    ${Else}
        IntOp $3 $1 & 0x400 ; FILE_ATTRIBUTE_REPARSE_POINT
        ${If} $3 != 0
            Goto profile_error
        ${EndIf}
        IntOp $3 $1 & 0x10 ; FILE_ATTRIBUTE_DIRECTORY
        ${If} $3 != ${DIRECTORY_ATTRIBUTE}
            Goto profile_error
        ${EndIf}
    ${EndIf}
!macroend

Section
    ${IfNot} ${RunningX64}
        MessageBox MB_OK|MB_ICONSTOP "Quiver Portable requires 64-bit Windows."
        SetErrorLevel 1
        Quit
    ${EndIf}

    IfFileExists "$EXEDIR\App\Quiver\Quiver.exe" launch
    MessageBox MB_OK|MB_ICONSTOP "Quiver.exe is missing. Reinstall Quiver Portable into this folder."
    SetErrorLevel 1
    Quit

launch:
    !insertmacro CheckDataPath "$EXEDIR\Data" 16
    !insertmacro CheckDataPath "$EXEDIR\Data\Temp" 16
    !insertmacro CheckDataPath "$EXEDIR\Data\Logs" 16
    !insertmacro CheckDataPath "$EXEDIR\Data\Logs\electron.log" 0

    ClearErrors
    CreateDirectory "$EXEDIR\Data\Temp"
    IfErrors profile_error
    CreateDirectory "$EXEDIR\Data\Logs"
    IfErrors profile_error
    SetOutPath "$EXEDIR\Data"
    IfErrors profile_error

    System::Call 'Kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR") i.r1'
    StrCmp $1 0 profile_error
    System::Call 'Kernel32::SetEnvironmentVariableW(w "TEMP", w "$EXEDIR\Data\Temp") i.r1'
    StrCmp $1 0 profile_error
    System::Call 'Kernel32::SetEnvironmentVariableW(w "TMP", w "$EXEDIR\Data\Temp") i.r1'
    StrCmp $1 0 profile_error
    System::Call 'Kernel32::SetEnvironmentVariableW(w "ELECTRON_LOG_FILE", w "$EXEDIR\Data\Logs\electron.log") i.r1'
    StrCmp $1 0 profile_error

    ${GetParameters} $0
    ClearErrors
    ; Chromium selects its user data before the main script. Forwarded URL arguments follow --.
    ExecWait '"$EXEDIR\App\Quiver\Quiver.exe" --user-data-dir="$EXEDIR\Data" -- $0' $1
    ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "Quiver could not start."
        SetErrorLevel 1
        Quit
    ${EndIf}
    SetErrorLevel $1
    Goto done

profile_error:
    MessageBox MB_OK|MB_ICONSTOP "Quiver could not prepare its portable Data folder. Check that the folder is writable and its paths are not redirected."
    SetErrorLevel 1
    Quit
done:
SectionEnd
