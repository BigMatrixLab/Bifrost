; Quanta installer look: dark, like the app (src/styles.css, dark theme),
; set in Space Grotesk.
;
; Tauri includes this file (bundle.windows.nsis.installerHooks) near the top
; of installer.nsi, after MUI2.nsh and before any page is declared, so the
; MUI_* defines below apply to every page. The custom template
; (installer.nsi next to this file) calls Quanta.DarkPage from each page's
; SHOW callback.
;
; Colours and fonts are set here. The controls themselves (buttons, check
; boxes, radio buttons, text fields, the progress bar) are drawn by the
; quanta_ui plugin (quanta-ui/, built into plugins/x86-unicode/).

!include "LogicLib.nsh"
!include "WinMessages.nsh"

; This file's folder; the fonts and the plugin live next to it.
!define QUANTA_DIR "${__FILEDIR__}"
!addplugindir /x86-unicode "${QUANTA_DIR}\plugins\x86-unicode"

; ------------------------------------------------------------------ palette

!define Q_BG "0B0B0D"      ; --surface
!define Q_FIELD "141417"   ; --raised
!define Q_TEXT "F2F2F2"    ; --text
!define Q_TEXT2 "A3A3A3"   ; --text-2
!define Q_TEXT3 "6A6A6A"   ; --text-3
; The same colours as Windows COLORREFs (0x00BBGGRR).
!define Q_BG_REF 0x000D0B0B
!define Q_EDGE_REF 0x00262222
!define Q_TEXT2_REF 0x00A3A3A3

; Dialog layout is measured in Segoe UI 10 (always present), which leaves
; room for Space Grotesk's taller lines; every control is then switched to
; Space Grotesk 9, which the installer carries and loads privately (nothing
; is installed on the system).
SetFont "Segoe UI" 10
Var Quanta.Font
Var Quanta.TitleFont
Var Quanta.HeaderFont

; --------------------------------------------------------------- MUI setup

!define MUI_BGCOLOR "${Q_BG}"
!define MUI_TEXTCOLOR "${Q_TEXT}"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_INSTFILESPAGE_COLORS "${Q_TEXT2} ${Q_BG}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_DIRECTORYPAGE_BGCOLOR "${Q_FIELD}"
!define MUI_DIRECTORYPAGE_TEXTCOLOR "${Q_TEXT}"
!define MUI_CUSTOMFUNCTION_GUIINIT Quanta.GuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.Quanta.GuiInit

!define MUI_WELCOMEPAGE_TITLE "Install $(^NameDA)"
!define MUI_WELCOMEPAGE_TEXT "$(^NameDA) sends very large files straight from one device to another. Transfers pick up where they left off after a dropped connection or a restart, and every byte is checked when it arrives.$\r$\n$\r$\nNo account, and no copy on anyone's server.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_TITLE "$(^NameDA) is ready"
!define MUI_FINISHPAGE_TEXT "$(^NameDA) is installed on this computer. Share a folder or connect to a device to start sending.$\r$\n$\r$\nClick Finish to close Setup."

; ------------------------------------------------------------- dark theming

!macro QUANTA_DARK_FUNCTIONS UN

; Once, when the window opens: fonts, the plugin, the dark title bar and
; frame, and the controls that stay for the whole run (header, buttons,
; branding line).
Function ${UN}Quanta.GuiInit
  Push $0
  ; Space Grotesk, unpacked to the temporary plugins folder and loaded for
  ; this process only.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\SpaceGrotesk-Regular.ttf" "${QUANTA_DIR}\fonts\SpaceGrotesk-Regular.ttf"
  File "/oname=$PLUGINSDIR\SpaceGrotesk-Medium.ttf" "${QUANTA_DIR}\fonts\SpaceGrotesk-Medium.ttf"
  File "/oname=$PLUGINSDIR\SpaceGrotesk-Bold.ttf" "${QUANTA_DIR}\fonts\SpaceGrotesk-Bold.ttf"
  quanta_ui::Init "$PLUGINSDIR"
  CreateFont $Quanta.Font "Space Grotesk" 9 400
  CreateFont $Quanta.HeaderFont "Space Grotesk" 11 700
  CreateFont $Quanta.TitleFont "Space Grotesk" 18 700

  ; DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+), then the caption and
  ; border colours (Windows 11; ignored elsewhere).
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${Q_BG_REF}, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${Q_EDGE_REF}, i 4)'
  SetCtlColors $HWNDPARENT ${Q_TEXT} ${Q_BG}
  Push $HWNDPARENT
  Call ${UN}Quanta.DarkChildren
  quanta_ui::Skin $HWNDPARENT
  ; No button strip under the welcome page's side panel: the window ends
  ; where the panel does and the buttons sit beside it.
  quanta_ui::Compact $HWNDPARENT

  ; The page title in the header, larger and bold.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETFONT} $Quanta.HeaderFont 1
  ; The copyright line: NSIS draws it disabled (embossed grey); show it as
  ; plain secondary text instead.
  ; (1256 is a second copy drawn a pixel off for that effect; Quanta.DarkDialog
  ; hides it on every page, since MUI shows it again.)
  GetDlgItem $0 $HWNDPARENT 1028
  EnableWindow $0 1
  SetCtlColors $0 ${Q_TEXT2} ${Q_BG}
  Pop $0
FunctionEnd

; Each page's SHOW callback: the page dialog and everything on it.
Function ${UN}Quanta.DarkPage
  Push $0
  FindWindow $0 "#32770" "" $HWNDPARENT
  Push $0
  Call ${UN}Quanta.DarkDialog
  Pop $0
FunctionEnd

; The page dialog on the stack, and the separator lines MUI shows again
; when it switches between full-window and normal pages.
Function ${UN}Quanta.DarkDialog
  Exch $0
  Push $1
  SetCtlColors $0 ${Q_TEXT} ${Q_BG}
  Push $0
  Call ${UN}Quanta.DarkChildren
  quanta_ui::Skin $0
  GetDlgItem $1 $HWNDPARENT 1035
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1045
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $HWNDPARENT 1256
  ShowWindow $1 ${SW_HIDE}
  Pop $1
  Pop $0
FunctionEnd

; Colours and the font for every child of the window on the stack.
Function ${UN}Quanta.DarkChildren
  Exch $0 ; parent window
  Push $1 ; child
  Push $2 ; class name
  Push $3 ; style or id
  StrCpy $1 0
  loop:
    FindWindow $1 "" "" $0 $1
    StrCmp $1 0 done
    SendMessage $1 ${WM_SETFONT} $Quanta.Font 1
    System::Call 'user32::GetClassName(p r1, t .r2, i 256)'
    ${If} $2 == "Button"
      System::Call 'user32::GetWindowLong(p r1, i -16) i .r3'
      IntOp $3 $3 & 0xF
      ${If} $3 = 7
        ; Group boxes draw a bright etched frame; the page text already
        ; says what the field is for.
        ShowWindow $1 ${SW_HIDE}
      ${EndIf}
    ${ElseIf} $2 == "Static"
      System::Call 'user32::GetWindowLong(p r1, i -16) i .r3'
      IntOp $3 $3 & 0x1F
      ${If} $3 = 0x10
      ${OrIf} $3 = 0x11
        ; Etched separator lines: too bright on dark, so hidden.
        ShowWindow $1 ${SW_HIDE}
      ${ElseIf} $3 <> 0x0E
        ; Text (bitmaps, style 0x0E, are left alone).
        System::Call 'user32::GetDlgCtrlID(p r1) i .r3'
        ${If} $3 = 1038 ; header subtitle
          SetCtlColors $1 ${Q_TEXT2} ${Q_BG}
        ${Else}
          SetCtlColors $1 ${Q_TEXT} ${Q_BG}
        ${EndIf}
      ${EndIf}
    ${ElseIf} $2 == "Edit"
      SetCtlColors $1 ${Q_TEXT} ${Q_FIELD}
    ${ElseIf} $2 == "SysListView32"
      System::Call 'uxtheme::SetWindowTheme(p r1, w "DarkMode_Explorer", p 0)'
      SendMessage $1 0x1001 0 ${Q_BG_REF}    ; LVM_SETBKCOLOR
      SendMessage $1 0x1026 0 ${Q_BG_REF}    ; LVM_SETTEXTBKCOLOR
      SendMessage $1 0x1024 0 ${Q_TEXT2_REF} ; LVM_SETTEXTCOLOR
    ${EndIf}
    Goto loop
  done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Moves the control on the stack to just below the page's text field. The
; uninstaller's "Delete the application data" box is created at a fixed
; pixel position, which the larger layout font would put on the field.
Function ${UN}Quanta.BelowField
  Exch $0 ; control to move
  Push $1 ; page dialog
  Push $2 ; text field
  Push $3 ; RECT buffer
  Push $4
  Push $5
  Push $6
  Push $7
  FindWindow $1 "#32770" "" $HWNDPARENT
  FindWindow $2 "Edit" "" $1
  ${If} $2 <> 0
    System::Call '*(i, i, i, i) p .r3'
    System::Call 'user32::GetWindowRect(p r2, p r3)'
    System::Call 'user32::MapWindowPoints(p 0, p r1, p r3, i 2)'
    System::Call '*$3(i, i, i, i .r7)' ; field bottom
    System::Call 'user32::GetWindowRect(p r0, p r3)'
    System::Call 'user32::MapWindowPoints(p 0, p r1, p r3, i 2)'
    System::Call '*$3(i .r4, i, i, i)' ; control left
    System::Free $3
    System::Call 'user32::GetDpiForWindow(p r1) i .r5'
    ${If} $5 = 0
      StrCpy $5 96
    ${EndIf}
    IntOp $6 $5 * 14
    IntOp $6 $6 / 96
    IntOp $7 $7 + $6
    System::Call 'user32::SetWindowPos(p r0, p 0, i r4, i r7, i 0, i 0, i 0x15)' ; no size, z-order, activation
  ${EndIf}
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macroend

!insertmacro QUANTA_DARK_FUNCTIONS ""
!insertmacro QUANTA_DARK_FUNCTIONS "un."

; Welcome and finish pages: the page colours, then a large title and
; softer body text. Their controls live in variables MUI declares with the
; pages, so the template inserts this macro after the finish page.
!macro QUANTA_WELCOME_FINISH_FUNCTIONS
Function Quanta.WelcomeShow
  Push $mui.WelcomePage
  Call Quanta.DarkDialog
  SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $Quanta.TitleFont 1
  SetCtlColors $mui.WelcomePage.Text ${Q_TEXT2} ${Q_BG}
FunctionEnd

Function Quanta.FinishShow
  Push $mui.FinishPage
  Call Quanta.DarkDialog
  SendMessage $mui.FinishPage.Title ${WM_SETFONT} $Quanta.TitleFont 1
  SetCtlColors $mui.FinishPage.Text ${Q_TEXT2} ${Q_BG}
FunctionEnd
!macroend
