Unicode true
Name "Quiver Portable"
OutFile "${OUTPUT}"
Icon "${APP_ICON}"
RequestExecutionLevel user
SilentInstall silent

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

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
    System::Call 'Kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR") i.r1'
    ${If} $1 == 0
        MessageBox MB_OK|MB_ICONSTOP "Quiver could not select its portable profile."
        SetErrorLevel 1
        Quit
    ${EndIf}

    ${GetParameters} $0
    SetOutPath "$EXEDIR\App\Quiver"
    ClearErrors
    ExecWait '"$EXEDIR\App\Quiver\Quiver.exe" $0' $1
    ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "Quiver could not start."
        SetErrorLevel 1
        Quit
    ${EndIf}
    SetErrorLevel $1
SectionEnd
