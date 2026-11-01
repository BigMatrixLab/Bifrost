//! bifrost_ui: an NSIS plugin that draws the installer's controls in the
//! Bifrost app's style (src/styles.css, dark theme).
//!
//! NSIS dialogs are plain Win32 controls, and the script can only set their
//! colours. This plugin subclasses them and paints them itself:
//!
//! - push buttons become owner-drawn: the main action (Next, Install,
//!   Finish, Uninstall) is solid green, the others are outlined with HUD
//!   corner brackets; labels are uppercase and letter-spaced;
//! - check boxes and radio buttons keep their behaviour but are painted as
//!   a green-filled square with a check mark, and a ring with a dot;
//! - text fields get a 1 px border that turns green while focused;
//! - progress bars become the app's segmented meter.
//!
//! Script API (see ../installer-hooks.nsh):
//!   bifrost_ui::Init "<dir>"   load the Space Grotesk files in <dir>
//!                              (privately) and keep the plugin loaded
//!   bifrost_ui::Skin <hwnd>     style the direct children of <hwnd>
//!   bifrost_ui::Compact <hwnd>  shrink the main window to the side panel's
//!                              height and put the buttons beside it
//!
//! NSIS is 32-bit, so this builds for i686 only (see build.ps1).

#![allow(non_snake_case, clippy::missing_safety_doc)]

use std::cell::RefCell;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};

type HWND = isize;
type HDC = isize;
type HGDIOBJ = isize;
type LRESULT = isize;
type WPARAM = usize;
type LPARAM = isize;
type COLORREF = u32;
type BOOL = i32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Default)]
struct SIZE {
    cx: i32,
    cy: i32,
}

#[repr(C)]
struct PAINTSTRUCT {
    hdc: HDC,
    fErase: BOOL,
    rcPaint: RECT,
    fRestore: BOOL,
    fIncUpdate: BOOL,
    rgbReserved: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct LOGFONTW {
    lfHeight: i32,
    lfWidth: i32,
    lfEscapement: i32,
    lfOrientation: i32,
    lfWeight: i32,
    lfItalic: u8,
    lfUnderline: u8,
    lfStrikeOut: u8,
    lfCharSet: u8,
    lfOutPrecision: u8,
    lfClipPrecision: u8,
    lfQuality: u8,
    lfPitchAndFamily: u8,
    lfFaceName: [u16; 32],
}

#[repr(C)]
struct TEXTMETRICW {
    tmHeight: i32,
    tmAscent: i32,
    tmDescent: i32,
    tmInternalLeading: i32,
    tmExternalLeading: i32,
    tmAveCharWidth: i32,
    tmMaxCharWidth: i32,
    tmWeight: i32,
    tmOverhang: i32,
    tmDigitizedAspectX: i32,
    tmDigitizedAspectY: i32,
    tmFirstChar: u16,
    tmLastChar: u16,
    tmDefaultChar: u16,
    tmBreakChar: u16,
    tmItalic: u8,
    tmUnderlined: u8,
    tmStruckOut: u8,
    tmPitchAndFamily: u8,
    tmCharSet: u8,
}

#[repr(C)]
struct TRACKMOUSEEVENT {
    cbSize: u32,
    dwFlags: u32,
    hwndTrack: HWND,
    dwHoverTime: u32,
}

#[repr(C)]
struct GdiplusStartupInput {
    version: u32,
    debug_callback: usize,
    suppress_background_thread: BOOL,
    suppress_external_codecs: BOOL,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PointF {
    x: f32,
    y: f32,
}

type SubclassProc = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM, usize, usize) -> LRESULT;

#[link(name = "user32")]
extern "system" {
    fn GetWindowLongW(h: HWND, i: i32) -> i32;
    fn SetWindowLongW(h: HWND, i: i32, v: i32) -> i32;
    fn GetWindowTextW(h: HWND, s: *mut u16, n: i32) -> i32;
    fn GetWindowTextLengthW(h: HWND) -> i32;
    fn GetClassNameW(h: HWND, s: *mut u16, n: i32) -> i32;
    fn GetClientRect(h: HWND, r: *mut RECT) -> BOOL;
    fn GetWindowRect(h: HWND, r: *mut RECT) -> BOOL;
    fn InvalidateRect(h: HWND, r: *const RECT, erase: BOOL) -> BOOL;
    fn BeginPaint(h: HWND, ps: *mut PAINTSTRUCT) -> HDC;
    fn EndPaint(h: HWND, ps: *const PAINTSTRUCT) -> BOOL;
    fn GetWindowDC(h: HWND) -> HDC;
    fn GetDC(h: HWND) -> HDC;
    fn MapDialogRect(h: HWND, r: *mut RECT) -> BOOL;
    fn ReleaseDC(h: HWND, dc: HDC) -> i32;
    fn FillRect(dc: HDC, r: *const RECT, br: isize) -> i32;
    fn DrawTextW(dc: HDC, s: *const u16, n: i32, r: *mut RECT, f: u32) -> i32;
    fn GetDlgCtrlID(h: HWND) -> i32;
    fn GetDlgItem(h: HWND, id: i32) -> HWND;
    fn MapWindowPoints(from: HWND, to: HWND, pts: *mut RECT, n: u32) -> i32;
    fn GetParent(h: HWND) -> HWND;
    fn GetWindow(h: HWND, cmd: u32) -> HWND;
    fn SendMessageW(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT;
    fn SetPropW(h: HWND, k: *const u16, v: isize) -> BOOL;
    fn GetPropW(h: HWND, k: *const u16) -> isize;
    fn RemovePropW(h: HWND, k: *const u16) -> isize;
    fn IsWindowEnabled(h: HWND) -> BOOL;
    fn IsWindowVisible(h: HWND) -> BOOL;
    fn IsWindow(h: HWND) -> BOOL;
    fn GetFocus() -> HWND;
    fn GetCapture() -> HWND;
    fn ShowWindow(h: HWND, cmd: i32) -> BOOL;
    fn SetTimer(h: HWND, id: usize, ms: u32, f: Option<unsafe extern "system" fn(HWND, u32, usize, u32)>) -> usize;
    fn KillTimer(h: HWND, id: usize) -> BOOL;
    fn RedrawWindow(h: HWND, r: *const RECT, rgn: isize, f: u32) -> BOOL;
    fn SetWindowPos(h: HWND, after: HWND, x: i32, y: i32, cx: i32, cy: i32, f: u32) -> BOOL;
    fn TrackMouseEvent(t: *mut TRACKMOUSEEVENT) -> BOOL;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateSolidBrush(c: COLORREF) -> isize;
    fn DeleteObject(o: HGDIOBJ) -> BOOL;
    fn SelectObject(dc: HDC, o: HGDIOBJ) -> HGDIOBJ;
    fn SetTextColor(dc: HDC, c: COLORREF) -> COLORREF;
    fn SetBkMode(dc: HDC, m: i32) -> i32;
    fn CreateCompatibleDC(dc: HDC) -> HDC;
    fn CreateCompatibleBitmap(dc: HDC, w: i32, h: i32) -> HGDIOBJ;
    fn BitBlt(d: HDC, x: i32, y: i32, w: i32, h: i32, s: HDC, sx: i32, sy: i32, rop: u32) -> BOOL;
    fn DeleteDC(dc: HDC) -> BOOL;
    fn CreateFontIndirectW(lf: *const LOGFONTW) -> HGDIOBJ;
    fn GetObjectW(o: HGDIOBJ, n: i32, out: *mut c_void) -> i32;
    fn SetTextCharacterExtra(dc: HDC, extra: i32) -> i32;
    fn AddFontResourceExW(name: *const u16, fl: u32, res: *mut c_void) -> i32;
    fn GetDeviceCaps(dc: HDC, i: i32) -> i32;
    fn GetTextMetricsW(dc: HDC, tm: *mut TEXTMETRICW) -> BOOL;
    fn GetTextExtentPoint32W(dc: HDC, s: *const u16, n: i32, size: *mut SIZE) -> BOOL;
    fn TextOutW(dc: HDC, x: i32, y: i32, s: *const u16, n: i32) -> BOOL;
    fn ExcludeClipRect(dc: HDC, l: i32, t: i32, r: i32, b: i32) -> i32;
}

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(h: HWND, p: SubclassProc, id: usize, data: usize) -> BOOL;
    fn RemoveWindowSubclass(h: HWND, p: SubclassProc, id: usize) -> BOOL;
    fn DefSubclassProc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT;
}

#[link(name = "kernel32")]
extern "system" {
    fn GlobalFree(h: isize) -> isize;
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetProcAddress(m: isize, name: *const u8) -> *const c_void;
}

#[link(name = "gdiplus")]
extern "system" {
    fn GdiplusStartup(token: *mut usize, input: *const GdiplusStartupInput, output: *mut c_void) -> i32;
    fn GdipCreateFromHDC(dc: HDC, g: *mut *mut c_void) -> i32;
    fn GdipDeleteGraphics(g: *mut c_void) -> i32;
    fn GdipSetSmoothingMode(g: *mut c_void, mode: i32) -> i32;
    fn GdipSetPixelOffsetMode(g: *mut c_void, mode: i32) -> i32;
    fn GdipCreatePen1(argb: u32, width: f32, unit: i32, pen: *mut *mut c_void) -> i32;
    fn GdipSetPenStartCap(pen: *mut c_void, cap: i32) -> i32;
    fn GdipSetPenEndCap(pen: *mut c_void, cap: i32) -> i32;
    fn GdipSetPenLineJoin(pen: *mut c_void, join: i32) -> i32;
    fn GdipDeletePen(pen: *mut c_void) -> i32;
    fn GdipCreateSolidFill(argb: u32, brush: *mut *mut c_void) -> i32;
    fn GdipDeleteBrush(brush: *mut c_void) -> i32;
    fn GdipDrawEllipse(g: *mut c_void, pen: *mut c_void, x: f32, y: f32, w: f32, h: f32) -> i32;
    fn GdipFillEllipse(g: *mut c_void, brush: *mut c_void, x: f32, y: f32, w: f32, h: f32) -> i32;
    fn GdipDrawLines(g: *mut c_void, pen: *mut c_void, pts: *const PointF, n: i32) -> i32;
}

// ------------------------------------------------------------- constants

const GWL_STYLE: i32 = -16;
const GWL_EXSTYLE: i32 = -20;
const GW_HWNDNEXT: u32 = 2;
const GW_CHILD: u32 = 5;

const WM_SETREDRAW: u32 = 0x000B;
const WM_SETTEXT: u32 = 0x000C;
const WM_PAINT: u32 = 0x000F;
const WM_ERASEBKGND: u32 = 0x0014;
const WM_SETFOCUS: u32 = 0x0007;
const WM_KILLFOCUS: u32 = 0x0008;
const WM_ENABLE: u32 = 0x000A;
const WM_CANCELMODE: u32 = 0x001F;
const WM_GETFONT: u32 = 0x0031;
const WM_NCDESTROY: u32 = 0x0082;
const WM_NCCALCSIZE: u32 = 0x0083;
const WM_NCPAINT: u32 = 0x0085;
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYUP: u32 = 0x0105;
const WM_CHANGEUISTATE: u32 = 0x0127;
const WM_UPDATEUISTATE: u32 = 0x0128;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;
const WM_CAPTURECHANGED: u32 = 0x0215;
const WM_MOUSELEAVE: u32 = 0x02A3;
const WM_PRINTCLIENT: u32 = 0x0318;

const BM_GETCHECK: u32 = 0x00F0;
const BM_SETCHECK: u32 = 0x00F1;
const BM_GETSTATE: u32 = 0x00F2;
const BM_SETSTATE: u32 = 0x00F3;
const BM_SETSTYLE: u32 = 0x00F4;
const BST_CHECKED: isize = 1;
const BST_PUSHED: isize = 4;

const BS_TYPEMASK: i32 = 0xF;
const BS_DEFPUSHBUTTON: i32 = 1;
const BS_CHECKBOX: i32 = 2;
const BS_AUTOCHECKBOX: i32 = 3;
const BS_RADIOBUTTON: i32 = 4;
const BS_3STATE: i32 = 5;
const BS_AUTO3STATE: i32 = 6;
const BS_AUTORADIOBUTTON: i32 = 9;
const BS_OWNERDRAW: i32 = 0xB;

const WS_BORDER: i32 = 0x0080_0000;
const WS_CLIPSIBLINGS: i32 = 0x0400_0000;
const WS_VISIBLE: i32 = 0x1000_0000;
const ES_MULTILINE: i32 = 0x0004;
const WS_EX_CLIENTEDGE: i32 = 0x0200;
const WS_EX_STATICEDGE: i32 = 0x0002_0000;

const EM_SETMARGINS: u32 = 0x00D3;
const EC_LEFTMARGIN: usize = 1;
const EC_RIGHTMARGIN: usize = 2;

const PBM_SETRANGE: u32 = 0x0401;
const PBM_SETPOS: u32 = 0x0402;
const PBM_DELTAPOS: u32 = 0x0403;
const PBM_STEPIT: u32 = 0x0405;
const PBM_SETRANGE32: u32 = 0x0406;
const PBM_GETRANGE: u32 = 0x0407;
const PBM_GETPOS: u32 = 0x0408;

const WM_QUERYUISTATE: u32 = 0x0129;
const UISF_HIDEFOCUS: isize = 0x1;

const DT_VCENTER: u32 = 0x0004;
const DT_SINGLELINE: u32 = 0x0020;
const DT_END_ELLIPSIS: u32 = 0x8000;
const DT_HIDEPREFIX: u32 = 0x0010_0000;

const RDW_INVALIDATE: u32 = 0x0001;
const RDW_ERASE: u32 = 0x0004;
const RDW_ALLCHILDREN: u32 = 0x0080;
const RDW_FRAME: u32 = 0x0400;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED_ONLY: u32 = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | 0x0020;
const SW_HIDE: i32 = 0;
const SW_SHOWNA: i32 = 8;
const TME_LEAVE: u32 = 0x0002;
const TRANSPARENT: i32 = 1;
const SRCCOPY: u32 = 0x00CC_0020;
const LOGPIXELSY: i32 = 90;
const FR_PRIVATE: u32 = 0x10;
const CLEARTYPE_QUALITY: u8 = 5;

// Palette, COLORREF (0x00BBGGRR) from src/styles.css (dark theme).
const fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    r | (g << 8) | (b << 16)
}
const BG: COLORREF = rgb(0x0B, 0x0B, 0x0D); // --surface
const TEXT: COLORREF = rgb(0xF2, 0xF2, 0xF2); // --text
const TEXT2: COLORREF = rgb(0xA3, 0xA3, 0xA3); // --text-2
const TEXT3: COLORREF = rgb(0x6A, 0x6A, 0x6A); // --text-3
const DIM: COLORREF = rgb(0x4A, 0x4A, 0x4D);
const FIELD: COLORREF = rgb(0x14, 0x14, 0x17); // --raised
const LINE: COLORREF = rgb(0x2A, 0x2A, 0x2E); // --border on the surface
const LINE_STRONG: COLORREF = rgb(0x45, 0x45, 0x48); // --border-strong
const LINE_HOT: COLORREF = rgb(0x6A, 0x6A, 0x6E);
const HOVER: COLORREF = rgb(0x17, 0x17, 0x1A);
const PRESS: COLORREF = rgb(0x1E, 0x1E, 0x22);
const ACCENT: COLORREF = rgb(0x4A, 0xDE, 0x80); // --accent
const ACCENT_HOT: COLORREF = rgb(0x86, 0xEF, 0xAC);
const ACCENT_PRESS: COLORREF = rgb(0x22, 0xC5, 0x5E);
const ACCENT_INK: COLORREF = rgb(0x05, 0x2E, 0x16); // --accent-ink
const TICK: COLORREF = rgb(0x26, 0x26, 0x2A);

/// COLORREF to GDI+ ARGB.
const fn argb(c: COLORREF) -> u32 {
    0xFF00_0000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)
}

const FACE_MEDIUM: &str = "Space Grotesk Medium";
const FONT_FILES: [&str; 3] = ["SpaceGrotesk-Regular.ttf", "SpaceGrotesk-Medium.ttf", "SpaceGrotesk-Bold.ttf"];

// Subclass ids.
const ID_BUTTON: usize = 0x5155_0001;
const ID_CHECK: usize = 0x5155_0003;
const ID_EDIT: usize = 0x5155_0004;
const ID_PROGRESS: usize = 0x5155_0005;
const ID_REPAINT: usize = 0x5155_0006;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

thread_local! {
    static PROP_HOT: Vec<u16> = wide("BifrostHot");
    static PROP_BTN: Vec<u16> = wide("BifrostBtn");
    static PROP_PAD: Vec<u16> = wide("BifrostPad");
    static FONTS: RefCell<Vec<(i32, HGDIOBJ)>> = const { RefCell::new(Vec::new()) };
}

fn prop_hot() -> *const u16 {
    PROP_HOT.with(|p| p.as_ptr())
}
fn prop_btn() -> *const u16 {
    PROP_BTN.with(|p| p.as_ptr())
}
/// On the compacted main window: the side panel's padding, x << 16 | y.
fn prop_pad() -> *const u16 {
    PROP_PAD.with(|p| p.as_ptr())
}

// ------------------------------------------------------------ NSIS ABI

#[repr(C)]
pub struct StackT {
    next: *mut StackT,
    text: [u16; 1],
}

#[repr(C)]
pub struct ExtraParameters {
    exec_flags: *mut c_void,
    execute_code_segment: unsafe extern "system" fn(i32, HWND) -> i32,
    validate_filename: unsafe extern "system" fn(*mut u16),
    register_plugin_callback: unsafe extern "system" fn(isize, unsafe extern "C" fn(i32) -> usize) -> i32,
}

extern "C" {
    static __ImageBase: u8;
}

unsafe extern "C" fn plugin_callback(_msg: i32) -> usize {
    0
}

unsafe fn pop_string(stacktop: *mut *mut StackT) -> Option<String> {
    if stacktop.is_null() || (*stacktop).is_null() {
        return None;
    }
    let top = *stacktop;
    let text = (top as *mut u8).add(size_of::<*mut StackT>()) as *const u16;
    let mut len = 0usize;
    while *text.add(len) != 0 {
        len += 1;
    }
    let s = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
    *stacktop = (*top).next;
    GlobalFree(top as isize);
    Some(s)
}

/// `bifrost_ui::Init "<font dir>"`: GDI+, the fonts, and staying loaded
/// (the subclass procedures live in this DLL for the rest of the run).
#[no_mangle]
pub unsafe extern "C" fn Init(_hwnd: HWND, _size: i32, _vars: *mut u16, stacktop: *mut *mut StackT, extra: *mut ExtraParameters) {
    if !extra.is_null() {
        ((*extra).register_plugin_callback)(&__ImageBase as *const u8 as isize, plugin_callback);
    }
    let input = GdiplusStartupInput { version: 1, debug_callback: 0, suppress_background_thread: 0, suppress_external_codecs: 0 };
    let mut token = 0usize;
    GdiplusStartup(&mut token, &input, null_mut());
    if let Some(dir) = pop_string(stacktop) {
        for f in FONT_FILES {
            let path = wide(&format!("{}\\{}", dir.trim_end_matches('\\'), f));
            AddFontResourceExW(path.as_ptr(), FR_PRIVATE, null_mut());
        }
    }
}

unsafe fn pop_hwnd(stacktop: *mut *mut StackT) -> Option<HWND> {
    let s = pop_string(stacktop)?;
    let h = s.trim().parse::<i64>().ok()? as HWND;
    (IsWindow(h) != 0).then_some(h)
}

/// `bifrost_ui::Skin <hwnd>`: styles every direct child of the window.
#[no_mangle]
pub unsafe extern "C" fn Skin(_hwnd: HWND, _size: i32, _vars: *mut u16, stacktop: *mut *mut StackT, _extra: *mut ExtraParameters) {
    let Some(parent) = pop_hwnd(stacktop) else { return };
    let mut child = GetWindow(parent, GW_CHILD);
    while child != 0 {
        skin(child);
        child = GetWindow(child, GW_HWNDNEXT);
    }
    match_fields(parent);
    fit_page(parent);
}

/// `bifrost_ui::Compact <hwnd>`: the main window ends where the welcome
/// page's side panel does, and the buttons sit at the bottom right with the
/// panel's own padding below and between them (once, before it is shown).
#[no_mangle]
pub unsafe extern "C" fn Compact(_hwnd: HWND, _size: i32, _vars: *mut u16, stacktop: *mut *mut StackT, _extra: *mut ExtraParameters) {
    let Some(main) = pop_hwnd(stacktop) else { return };
    let full = GetDlgItem(main, 1044);
    if full == 0 || GetDlgItem(main, 1) == 0 || GetPropW(main, prop_pad()) != 0 {
        return;
    }
    // MUI2 creates the side panel as 0u 0u 109u 193u in control 1044; its
    // art (164 x 314) has the dots and brackets inset 8 px all round.
    let mut panel = RECT { left: 0, top: 0, right: 109, bottom: 193 };
    MapDialogRect(main, &mut panel);
    let pad_x = ((panel.right as f32) * 8.0 / 164.0).round().max(1.0) as i32;
    let pad_y = ((panel.bottom as f32) * 8.0 / 314.0).round().max(1.0) as i32;
    let height = child_rect(main, full).top + panel.bottom;
    let mut client = RECT::default();
    GetClientRect(main, &mut client);
    let shrink = client.bottom - height;
    if shrink > 0 {
        let mut wr = RECT::default();
        GetWindowRect(main, &mut wr);
        SetWindowPos(main, 0, wr.left, wr.top + shrink / 2, wr.right - wr.left, wr.bottom - wr.top - shrink, SWP_NOZORDER | SWP_NOACTIVATE);
    }
    SetPropW(main, prop_pad(), ((pad_x << 16) | pad_y) as isize);
    layout_row(main);
}

unsafe fn pads(main: HWND) -> Option<(i32, i32)> {
    let p = GetPropW(main, prop_pad()) as i32;
    (p != 0).then_some((p >> 16, p & 0xFFFF))
}

/// WS_VISIBLE on the control itself: pages are styled before they're shown,
/// when IsWindowVisible is false for everything on them.
unsafe fn shown(h: HWND) -> bool {
    GetWindowLongW(h, GWL_STYLE) & WS_VISIBLE != 0
}

unsafe fn child_rect(parent: HWND, h: HWND) -> RECT {
    let mut r = RECT::default();
    GetWindowRect(h, &mut r);
    MapWindowPoints(0, parent, &mut r, 2);
    r
}

/// Cancel, Next and Back from the bottom right corner, one padding apart;
/// the branding line centred on the same row.
unsafe fn layout_row(main: HWND) {
    let Some((pad_x, pad_y)) = pads(main) else { return };
    let mut client = RECT::default();
    GetClientRect(main, &mut client);
    let bottom = client.bottom - pad_y;
    let mut right = client.right - pad_x;
    let mut row = (bottom, bottom);
    for id in [2, 1, 3] {
        let b = GetDlgItem(main, id);
        if b == 0 {
            continue;
        }
        let r = child_rect(main, b);
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        SetWindowPos(b, 0, right - w, bottom - h, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        right -= w + pad_x;
        row.0 = row.0.min(bottom - h);
    }
    // NSIS makes the branding line nearly window-wide; end it before Back.
    let brand = GetDlgItem(main, 1028);
    if brand != 0 {
        let r = child_rect(main, brand);
        let h = r.bottom - r.top;
        let w = (r.right - r.left).min(right - r.left).max(0);
        SetWindowPos(brand, 0, r.left, (row.0 + row.1 - h) / 2, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

/// Once the window is compacted, a page overlaps the button row: keep the
/// buttons (and, beside the header pages, the branding line) above it, and
/// end tall controls such as the install log above the row.
unsafe fn fit_page(page: HWND) {
    let main = GetParent(page);
    let Some((_, pad_y)) = (if main != 0 { pads(main) } else { None }) else { return };
    SetWindowLongW(page, GWL_STYLE, GetWindowLongW(page, GWL_STYLE) | WS_CLIPSIBLINGS);
    let full = GetDlgItem(main, 1044);
    let full_page = full != 0 && child_rect(main, page).top <= child_rect(main, full).top;
    // MUI leaves the header background showing behind full-window pages,
    // where it would now clip the page.
    let header = GetDlgItem(main, 1034);
    if header != 0 && shown(header) == full_page {
        ShowWindow(header, if full_page { SW_HIDE } else { SW_SHOWNA });
    }
    SetWindowPos(page, 0, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    let ids: &[i32] = if full_page { &[1, 2, 3] } else { &[1028, 1, 2, 3] };
    let mut row = RECT { left: i32::MAX, top: i32::MAX, right: 0, bottom: 0 };
    for &id in ids {
        let b = GetDlgItem(main, id);
        if b == 0 {
            continue;
        }
        SetWindowPos(b, 0, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        if id != 1028 && shown(b) {
            let r = child_rect(main, b);
            row.left = row.left.min(r.left);
            row.top = row.top.min(r.top);
            row.bottom = row.bottom.max(r.bottom);
        }
    }
    // Pages are styled before they're shown, and MUI turns redrawing off and
    // on around full-window pages without repainting; repaint once shown.
    SetTimer(main, ID_REPAINT, 30, Some(repaint_soon));
    if row.top == i32::MAX {
        return;
    }
    if !full_page {
        clear_branding(main, page, pad_y);
    }
    let limit = row.top - pad_y;
    let tall = 3 * (row.bottom - row.top);
    let mut c = GetWindow(page, GW_CHILD);
    while c != 0 {
        let r = child_rect(main, c);
        if r.bottom > limit && r.right > row.left && r.bottom - r.top > tall && limit - r.top > tall / 3 {
            SetWindowPos(c, 0, 0, 0, r.right - r.left, limit - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
        c = GetWindow(c, GW_HWNDNEXT);
    }
}

unsafe extern "system" fn repaint_soon(h: HWND, _msg: u32, id: usize, _time: u32) {
    KillTimer(h, id);
    RedrawWindow(h, null(), 0, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_FRAME);
}

/// The branding line now shares the button row, where some pages have
/// controls (the folder page's space lines): lift the group of controls
/// that reaches it, or hide the line on that page if there's no room.
unsafe fn clear_branding(main: HWND, page: HWND, pad_y: i32) {
    let brand = GetDlgItem(main, 1028);
    if brand == 0 {
        return;
    }
    let b = child_rect(main, brand);
    let limit = b.top - 2 * pad_y;
    let mut kids = Vec::new();
    let mut c = GetWindow(page, GW_CHILD);
    while c != 0 {
        if shown(c) {
            kids.push((c, child_rect(main, c)));
        }
        c = GetWindow(c, GW_HWNDNEXT);
    }
    let hits = |r: &RECT| r.bottom > limit && r.top < b.bottom && r.left < b.right && r.right > b.left;
    let over = kids.iter().filter(|(_, r)| hits(r)).map(|(_, r)| r.bottom - limit).max().unwrap_or(0);
    if over <= 0 {
        ShowWindow(brand, SW_SHOWNA);
        return;
    }
    let first = kids.iter().filter(|(_, r)| hits(r)).map(|(_, r)| r.top).min().unwrap_or(limit);
    let reach = first - 3 * (b.bottom - b.top);
    let group_top = kids.iter().filter(|(_, r)| r.top >= reach).map(|(_, r)| r.top).min().unwrap_or(first);
    let above = kids.iter().filter(|(_, r)| r.top < reach).map(|(_, r)| r.bottom).max().unwrap_or(0);
    if group_top - over < above + pad_y {
        ShowWindow(brand, SW_HIDE);
        return;
    }
    for (h, _) in kids.iter().filter(|(_, r)| r.top >= reach) {
        let r = child_rect(page, *h);
        SetWindowPos(*h, 0, r.left, r.top - over, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    ShowWindow(brand, SW_SHOWNA);
}

/// A single-line text field beside a push button (the folder field and
/// Browse) takes the button's height.
unsafe fn match_fields(parent: HWND) {
    let mut e = GetWindow(parent, GW_CHILD);
    while e != 0 {
        if class_name(e).eq_ignore_ascii_case("Edit") && GetWindowLongW(e, GWL_STYLE) & ES_MULTILINE == 0 {
            let er = child_rect(parent, e);
            let mut b = GetWindow(parent, GW_CHILD);
            while b != 0 {
                if GetPropW(b, prop_btn()) != 0 {
                    let br = child_rect(parent, b);
                    if br.top < er.bottom && br.bottom > er.top {
                        if br.top != er.top || br.bottom != er.bottom {
                            SetWindowPos(e, 0, er.left, br.top, er.right - er.left, br.bottom - br.top, SWP_NOZORDER | SWP_NOACTIVATE);
                        }
                        break;
                    }
                }
                b = GetWindow(b, GW_HWNDNEXT);
            }
        }
        e = GetWindow(e, GW_HWNDNEXT);
    }
}

unsafe fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe fn skin(h: HWND) {
    let class = class_name(h);
    if class.eq_ignore_ascii_case("Button") {
        let style = GetWindowLongW(h, GWL_STYLE);
        match style & BS_TYPEMASK {
            0 | BS_DEFPUSHBUTTON | BS_OWNERDRAW => skin_push(h, style),
            BS_CHECKBOX | BS_AUTOCHECKBOX | BS_3STATE | BS_AUTO3STATE | BS_RADIOBUTTON | BS_AUTORADIOBUTTON => {
                fit_check(h);
                SetWindowSubclass(h, check_proc, ID_CHECK, 0);
                InvalidateRect(h, null(), 0);
            }
            _ => {}
        }
    } else if class.eq_ignore_ascii_case("Edit") {
        skin_edit(h);
    } else if class.eq_ignore_ascii_case("msctls_progress32") {
        let ex = GetWindowLongW(h, GWL_EXSTYLE) & !(WS_EX_CLIENTEDGE | WS_EX_STATICEDGE);
        SetWindowLongW(h, GWL_EXSTYLE, ex);
        SetWindowLongW(h, GWL_STYLE, GetWindowLongW(h, GWL_STYLE) & !WS_BORDER);
        SetWindowPos(h, 0, 0, 0, 0, 0, SWP_FRAMECHANGED_ONLY);
        SetWindowSubclass(h, progress_proc, ID_PROGRESS, 0);
        InvalidateRect(h, null(), 1);
    }
}

// ---------------------------------------------------------------- helpers

unsafe fn dpi_scale(h: HWND) -> f32 {
    type GetDpi = unsafe extern "system" fn(HWND) -> u32;
    let user32 = GetModuleHandleW(wide("user32.dll").as_ptr());
    let f = GetProcAddress(user32, b"GetDpiForWindow\0".as_ptr());
    let dpi = if !f.is_null() {
        let get: GetDpi = std::mem::transmute(f);
        get(h)
    } else {
        let dc = GetWindowDC(h);
        let d = GetDeviceCaps(dc, LOGPIXELSY) as u32;
        ReleaseDC(h, dc);
        d
    };
    if dpi == 0 {
        1.0
    } else {
        dpi as f32 / 96.0
    }
}

fn px(v: f32, s: f32) -> i32 {
    ((v * s).round() as i32).max(1)
}

unsafe fn fill(dc: HDC, r: &RECT, c: COLORREF) {
    let b = CreateSolidBrush(c);
    FillRect(dc, r, b);
    DeleteObject(b);
}

/// A rectangle outline `t` pixels thick.
unsafe fn frame(dc: HDC, r: &RECT, t: i32, c: COLORREF) {
    let b = CreateSolidBrush(c);
    let sides = [
        RECT { left: r.left, top: r.top, right: r.right, bottom: r.top + t },
        RECT { left: r.left, top: r.bottom - t, right: r.right, bottom: r.bottom },
        RECT { left: r.left, top: r.top, right: r.left + t, bottom: r.bottom },
        RECT { left: r.right - t, top: r.top, right: r.right, bottom: r.bottom },
    ];
    for s in &sides {
        FillRect(dc, s, b);
    }
    DeleteObject(b);
}

/// HUD corner marks: an L of length `l` and thickness `t` at each corner.
unsafe fn brackets(dc: HDC, r: &RECT, l: i32, t: i32, c: COLORREF) {
    let b = CreateSolidBrush(c);
    let (x0, y0, x1, y1) = (r.left, r.top, r.right, r.bottom);
    let parts = [
        RECT { left: x0, top: y0, right: x0 + l, bottom: y0 + t },
        RECT { left: x0, top: y0, right: x0 + t, bottom: y0 + l },
        RECT { left: x1 - l, top: y0, right: x1, bottom: y0 + t },
        RECT { left: x1 - t, top: y0, right: x1, bottom: y0 + l },
        RECT { left: x0, top: y1 - t, right: x0 + l, bottom: y1 },
        RECT { left: x0, top: y1 - l, right: x0 + t, bottom: y1 },
        RECT { left: x1 - l, top: y1 - t, right: x1, bottom: y1 },
        RECT { left: x1 - t, top: y1 - l, right: x1, bottom: y1 },
    ];
    for p in &parts {
        FillRect(dc, p, b);
    }
    DeleteObject(b);
}

unsafe fn window_text(h: HWND) -> Vec<u16> {
    let n = GetWindowTextLengthW(h);
    let mut buf = vec![0u16; (n.max(0) + 1) as usize];
    let got = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
    buf.truncate(got.max(0) as usize);
    buf
}

/// The control's font, as a LOGFONT.
unsafe fn control_logfont(h: HWND) -> Option<LOGFONTW> {
    let font = SendMessageW(h, WM_GETFONT, 0, 0);
    if font == 0 {
        return None;
    }
    let mut lf: LOGFONTW = zeroed();
    if GetObjectW(font, size_of::<LOGFONTW>() as i32, &mut lf as *mut _ as *mut c_void) == 0 {
        return None;
    }
    Some(lf)
}

unsafe fn text_metrics(dc: HDC) -> TEXTMETRICW {
    let mut tm: TEXTMETRICW = zeroed();
    GetTextMetricsW(dc, &mut tm);
    tm
}

/// The line height of the control's font.
unsafe fn font_height(h: HWND) -> i32 {
    let font = SendMessageW(h, WM_GETFONT, 0, 0);
    let dc = GetDC(h);
    let old = if font != 0 { SelectObject(dc, font) } else { 0 };
    let tm = text_metrics(dc);
    if old != 0 {
        SelectObject(dc, old);
    }
    ReleaseDC(h, dc);
    tm.tmHeight
}

/// Space Grotesk Medium at the control's size, for button labels (cached).
unsafe fn label_font(h: HWND) -> HGDIOBJ {
    let base = control_logfont(h);
    let height = base.map(|l| l.lfHeight).unwrap_or(-12);
    FONTS.with(|fonts| {
        let mut fonts = fonts.borrow_mut();
        if let Some(&(_, f)) = fonts.iter().find(|(ht, _)| *ht == height) {
            return f;
        }
        let mut lf: LOGFONTW = base.unwrap_or_else(|| zeroed());
        lf.lfHeight = height;
        lf.lfWeight = 400;
        lf.lfQuality = CLEARTYPE_QUALITY;
        lf.lfFaceName = [0; 32];
        for (i, c) in FACE_MEDIUM.encode_utf16().enumerate().take(31) {
            lf.lfFaceName[i] = c;
        }
        let f = CreateFontIndirectW(&lf);
        fonts.push((height, f));
        f
    })
}

/// "< &Back" → "BACK", "&Next >" → "NEXT".
fn button_label(raw: &[u16]) -> Vec<u16> {
    let s = String::from_utf16_lossy(raw);
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    let t = out.trim().trim_start_matches('<').trim_end_matches('>').trim();
    t.to_uppercase().encode_utf16().collect()
}

/// Paints `paint` into an off-screen bitmap, then copies it to `dc`.
unsafe fn buffered(dc: HDC, r: &RECT, paint: impl FnOnce(HDC, &RECT)) {
    let w = r.right - r.left;
    let h = r.bottom - r.top;
    if w <= 0 || h <= 0 {
        return;
    }
    let mem = CreateCompatibleDC(dc);
    let bmp = CreateCompatibleBitmap(dc, w, h);
    let old = SelectObject(mem, bmp);
    let local = RECT { left: 0, top: 0, right: w, bottom: h };
    paint(mem, &local);
    BitBlt(dc, r.left, r.top, w, h, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
}

unsafe fn track_hot(h: HWND) {
    if GetPropW(h, prop_hot()) == 0 {
        SetPropW(h, prop_hot(), 1);
        let mut t = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: h, dwHoverTime: 0 };
        TrackMouseEvent(&mut t);
        InvalidateRect(h, null(), 0);
    }
}

// ---------------------------------------------------------- push buttons

unsafe fn skin_push(h: HWND, style: i32) {
    // 1 = default push button; remembered so Enter-key styling survives.
    let is_default = (style & BS_TYPEMASK) == BS_DEFPUSHBUTTON;
    SetPropW(h, prop_btn(), if is_default { 2 } else { 1 });
    // Owner-drawn so the stock button paints nothing itself; the subclass
    // paints it. (WM_DRAWITEM to the parent is left alone: subclassing the
    // NSIS window crashes when nsDialogs pages swap its window procedure.)
    SetWindowLongW(h, GWL_STYLE, (style & !BS_TYPEMASK) | BS_OWNERDRAW);
    SetWindowSubclass(h, button_proc, ID_BUTTON, 0);
    fit_button(h);
    InvalidateRect(h, null(), 0);
}

/// Width of the label's letters in `dc` (set up with `extra` spacing),
/// without the spacing after the last one.
unsafe fn label_width(dc: HDC, label: &[u16], extra: i32) -> i32 {
    let mut size = SIZE::default();
    GetTextExtentPoint32W(dc, label.as_ptr(), label.len() as i32, &mut size);
    size.cx - extra
}

/// Letter spacing of button labels.
fn label_extra(s: f32) -> i32 {
    px(1.3, s)
}

/// Widens the button if its uppercase, letter-spaced label doesn't fit with
/// some room each side. The bottom row is laid out again; other buttons grow
/// away from the nearer edge of their dialog.
unsafe fn fit_button(h: HWND) {
    let label = button_label(&window_text(h));
    if label.is_empty() {
        return;
    }
    let s = dpi_scale(h);
    let extra = label_extra(s);
    let dc = GetDC(h);
    let old = SelectObject(dc, label_font(h));
    SetTextCharacterExtra(dc, extra);
    let ink = label_width(dc, &label, extra);
    SetTextCharacterExtra(dc, 0);
    SelectObject(dc, old);
    ReleaseDC(h, dc);
    let need = ink + 2 * px(20.0, s);
    let parent = GetParent(h);
    let r = child_rect(parent, h);
    if need <= r.right - r.left {
        return;
    }
    let height = r.bottom - r.top;
    if pads(parent).is_some() && matches!(GetDlgCtrlID(h), 1..=3) {
        SetWindowPos(h, 0, 0, 0, need, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        layout_row(parent);
        return;
    }
    let mut pr = RECT::default();
    GetClientRect(parent, &mut pr);
    let left = if r.left + r.right < pr.right { r.left } else { r.right - need };
    SetWindowPos(h, 0, left, r.top, need, height, SWP_NOZORDER | SWP_NOACTIVATE);
}

unsafe extern "system" fn button_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_MOUSEMOVE => {
            track_hot(h);
        }
        WM_MOUSELEAVE => {
            RemovePropW(h, prop_hot());
            InvalidateRect(h, null(), 0);
        }
        BM_SETSTYLE => {
            // The dialog manager toggles BS_DEFPUSHBUTTON as focus moves;
            // keep the button owner-drawn.
            let style = w as i32;
            SetPropW(h, prop_btn(), if (style & BS_TYPEMASK) == BS_DEFPUSHBUTTON { 2 } else { 1 });
            let r = DefSubclassProc(h, msg, ((style & !BS_TYPEMASK) | BS_OWNERDRAW) as usize, l);
            InvalidateRect(h, null(), 0);
            return r;
        }
        WM_SETTEXT | WM_ENABLE => {
            let r = DefSubclassProc(h, msg, w, l);
            if msg == WM_SETTEXT {
                fit_button(h);
            }
            InvalidateRect(h, null(), 0);
            return r;
        }
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = zeroed();
            let dc = BeginPaint(h, &mut ps);
            draw_button(h, dc);
            EndPaint(h, &ps);
            return 0;
        }
        WM_PRINTCLIENT => {
            draw_button(h, w as HDC);
            return 0;
        }
        WM_ERASEBKGND => return 1,
        WM_NCDESTROY => {
            RemovePropW(h, prop_hot());
            RemovePropW(h, prop_btn());
            RemoveWindowSubclass(h, button_proc, ID_BUTTON);
            return DefSubclassProc(h, msg, w, l);
        }
        _ => {}
    }
    if repaints_directly(msg) && (msg != WM_MOUSEMOVE || GetCapture() == h) {
        // Press, focus and keyboard-cue changes only send the parent
        // WM_DRAWITEM; repaint here instead.
        let r = DefSubclassProc(h, msg, w, l);
        if IsWindow(h) != 0 {
            InvalidateRect(h, null(), 0);
        }
        return r;
    }
    DefSubclassProc(h, msg, w, l)
}

unsafe fn draw_button(h: HWND, hdc: HDC) {
    let mut rc = RECT::default();
    GetClientRect(h, &mut rc);
    let s = dpi_scale(h);
    let disabled = IsWindowEnabled(h) == 0;
    let pressed = SendMessageW(h, BM_GETSTATE, 0, 0) & BST_PUSHED != 0;
    let hot = GetPropW(h, prop_hot()) != 0 && !disabled;
    let focused = GetFocus() == h && SendMessageW(h, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS == 0;
    // The main action: IDOK (Next / Install / Finish / Uninstall) on the
    // main window.
    let primary = GetDlgCtrlID(h) == 1;
    let label = button_label(&window_text(h));
    let font = label_font(h);

    buffered(hdc, &rc, |dc, r| {
        fill(dc, r, BG);
        let text;
        if primary {
            let face = if disabled {
                LINE
            } else if pressed {
                ACCENT_PRESS
            } else if hot {
                ACCENT_HOT
            } else {
                ACCENT
            };
            fill(dc, r, face);
            text = if disabled { DIM } else { ACCENT_INK };
            if focused && !disabled {
                // A dark inner ring shows keyboard focus on the green face.
                let inset = px(2.0, s);
                let inner = RECT { left: r.left + inset, top: r.top + inset, right: r.right - inset, bottom: r.bottom - inset };
                frame(dc, &inner, px(1.0, s), ACCENT_INK);
            }
        } else {
            if pressed && !disabled {
                fill(dc, r, PRESS);
            } else if hot {
                fill(dc, r, HOVER);
            }
            let edge = if disabled { LINE } else if hot || pressed { LINE_HOT } else { LINE_STRONG };
            frame(dc, r, px(1.0, s), edge);
            let mark = if disabled { LINE_STRONG } else if focused { ACCENT } else { TEXT };
            brackets(dc, r, px(7.0, s), px(1.5, s), mark);
            text = if disabled { DIM } else { TEXT };
        }
        let old = SelectObject(dc, font);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, text);
        let extra = label_extra(s);
        SetTextCharacterExtra(dc, extra);
        // Centre the letters themselves (DT_CENTER ignores the spacing), and
        // the cap height rather than the line, as labels are all caps.
        let tm = text_metrics(dc);
        let cap = tm.tmAscent - tm.tmInternalLeading;
        let x = r.left + (r.right - r.left - label_width(dc, &label, extra)) / 2;
        let mut y = r.top + (r.bottom - r.top - cap + 1) / 2 - tm.tmInternalLeading;
        if pressed && !disabled {
            y += 1;
        }
        TextOutW(dc, x, y, label.as_ptr(), label.len() as i32);
        SetTextCharacterExtra(dc, 0);
        SelectObject(dc, old);
    });
}

// ------------------------------------------- check boxes and radio buttons

/// Messages after which the stock button repaints itself directly (not via
/// WM_PAINT). They run with redraw off, then we repaint our way.
fn repaints_directly(msg: u32) -> bool {
    matches!(
        msg,
        BM_SETCHECK
            | BM_SETSTATE
            | WM_SETFOCUS
            | WM_KILLFOCUS
            | WM_ENABLE
            | WM_SETTEXT
            | WM_LBUTTONDOWN
            | WM_LBUTTONUP
            | WM_LBUTTONDBLCLK
            | WM_KEYDOWN
            | WM_KEYUP
            | WM_SYSKEYUP
            | WM_MOUSEMOVE
            | WM_CAPTURECHANGED
            | WM_CANCELMODE
            | WM_UPDATEUISTATE
            | WM_CHANGEUISTATE
    )
}

unsafe extern "system" fn check_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = zeroed();
            let dc = BeginPaint(h, &mut ps);
            paint_check(h, dc);
            EndPaint(h, &ps);
            return 0;
        }
        WM_PRINTCLIENT => {
            paint_check(h, w as HDC);
            return 0;
        }
        WM_ERASEBKGND => return 1,
        WM_MOUSELEAVE => {
            RemovePropW(h, prop_hot());
            InvalidateRect(h, null(), 0);
        }
        WM_NCDESTROY => {
            RemovePropW(h, prop_hot());
            RemoveWindowSubclass(h, check_proc, ID_CHECK);
            return DefSubclassProc(h, msg, w, l);
        }
        _ => {}
    }
    if msg == WM_MOUSEMOVE {
        track_hot(h);
    }
    if repaints_directly(msg) && IsWindowVisible(h) != 0 {
        DefSubclassProc(h, WM_SETREDRAW, 0, 0);
        let r = DefSubclassProc(h, msg, w, l);
        if IsWindow(h) != 0 {
            DefSubclassProc(h, WM_SETREDRAW, 1, 0);
            InvalidateRect(h, null(), 0);
        }
        return r;
    }
    DefSubclassProc(h, msg, w, l)
}

/// The box's size and the gap to its focus marks.
fn check_box_metrics(s: f32) -> (i32, i32) {
    (px(15.0, s), px(3.0, s))
}

/// Tall enough for the box and its focus marks, about the same centre.
unsafe fn fit_check(h: HWND) {
    let s = dpi_scale(h);
    let (size, gap) = check_box_metrics(s);
    let need = size + 2 * (gap + px(1.0, s)) + px(2.0, s);
    let parent = GetParent(h);
    let r = child_rect(parent, h);
    let height = r.bottom - r.top;
    if height < need {
        let top = r.top - (need - height) / 2;
        SetWindowPos(h, 0, r.left, top, r.right - r.left, need, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

unsafe fn paint_check(h: HWND, dc: HDC) {
    let mut rc = RECT::default();
    GetClientRect(h, &mut rc);
    let s = dpi_scale(h);
    let style = GetWindowLongW(h, GWL_STYLE) & BS_TYPEMASK;
    let radio = style == BS_RADIOBUTTON || style == BS_AUTORADIOBUTTON;
    let checked = SendMessageW(h, BM_GETCHECK, 0, 0) == BST_CHECKED;
    let pushed = SendMessageW(h, BM_GETSTATE, 0, 0) & BST_PUSHED != 0;
    let disabled = IsWindowEnabled(h) == 0;
    let hot = GetPropW(h, prop_hot()) != 0 && !disabled;
    let focused = GetFocus() == h;
    let text = window_text(h);
    let font = SendMessageW(h, WM_GETFONT, 0, 0);

    buffered(dc, &rc, |dc, r| {
        fill(dc, r, BG);
        let (size, gap) = check_box_metrics(s);
        let size = size.min(r.bottom - r.top - 2 * gap).max(px(8.0, s));
        let top = r.top + (r.bottom - r.top - size) / 2;
        let left = r.left + gap + px(1.0, s);
        let bx = RECT { left, top, right: left + size, bottom: top + size };
        let edge = if disabled {
            LINE
        } else if checked {
            ACCENT
        } else if hot || pushed || focused {
            TEXT2
        } else {
            TEXT3
        };

        if radio {
            gdiplus(dc, |g| {
                let (x, y, d) = (bx.left as f32 + 0.5, bx.top as f32 + 0.5, size as f32 - 1.0);
                let mut pen = null_mut();
                GdipCreatePen1(argb(edge), (1.4 * s).max(1.0), 2, &mut pen);
                GdipDrawEllipse(g, pen, x, y, d, d);
                GdipDeletePen(pen);
                if checked {
                    let mut brush = null_mut();
                    GdipCreateSolidFill(argb(if disabled { LINE_STRONG } else { ACCENT }), &mut brush);
                    let dot = d * 0.46;
                    let off = (d - dot) / 2.0;
                    GdipFillEllipse(g, brush, x + off, y + off, dot, dot);
                    GdipDeleteBrush(brush);
                }
            });
        } else if checked {
            fill(dc, &bx, if disabled { LINE_STRONG } else { ACCENT });
            gdiplus(dc, |g| {
                let mut pen = null_mut();
                GdipCreatePen1(argb(if disabled { BG } else { ACCENT_INK }), 2.0 * s, 2, &mut pen);
                GdipSetPenStartCap(pen, 2);
                GdipSetPenEndCap(pen, 2);
                GdipSetPenLineJoin(pen, 2);
                let (x, y, d) = (bx.left as f32, bx.top as f32, size as f32);
                let pts = [
                    PointF { x: x + d * 0.24, y: y + d * 0.52 },
                    PointF { x: x + d * 0.43, y: y + d * 0.70 },
                    PointF { x: x + d * 0.77, y: y + d * 0.32 },
                ];
                GdipDrawLines(g, pen, pts.as_ptr(), pts.len() as i32);
                GdipDeletePen(pen);
            });
        } else {
            if hot || pushed {
                fill(dc, &bx, HOVER);
            }
            frame(dc, &bx, px(1.0, s), edge);
        }

        if focused && !disabled {
            // Green corner marks around the box show keyboard focus.
            let ring = RECT { left: bx.left - gap, top: bx.top - gap, right: bx.right + gap, bottom: bx.bottom + gap };
            brackets(dc, &ring, px(4.0, s), px(1.0, s), ACCENT);
        }

        let old = if font != 0 { SelectObject(dc, font) } else { 0 };
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, if disabled { DIM } else { TEXT });
        let mut tr = RECT { left: bx.right + px(9.0, s), top: r.top, right: r.right, bottom: r.bottom };
        DrawTextW(dc, text.as_ptr(), text.len() as i32, &mut tr, DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_HIDEPREFIX);
        if old != 0 {
            SelectObject(dc, old);
        }
    });
}

unsafe fn gdiplus(dc: HDC, draw: impl FnOnce(*mut c_void)) {
    let mut g = null_mut();
    if GdipCreateFromHDC(dc, &mut g) != 0 || g.is_null() {
        return;
    }
    GdipSetSmoothingMode(g, 4); // anti-alias
    GdipSetPixelOffsetMode(g, 4); // half: pixel centres on .5
    draw(g);
    GdipDeleteGraphics(g);
}

// ------------------------------------------------------------ text fields

unsafe fn skin_edit(h: HWND) {
    let ex = GetWindowLongW(h, GWL_EXSTYLE) & !(WS_EX_CLIENTEDGE | WS_EX_STATICEDGE);
    SetWindowLongW(h, GWL_EXSTYLE, ex);
    SetWindowLongW(h, GWL_STYLE, GetWindowLongW(h, GWL_STYLE) | WS_BORDER);
    SetWindowSubclass(h, edit_proc, ID_EDIT, 0);
    SetWindowPos(h, 0, 0, 0, 0, 0, SWP_FRAMECHANGED_ONLY);
    let m = px(8.0, dpi_scale(h)) as usize;
    SendMessageW(h, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, ((m << 16) | m) as isize);
    RedrawWindow(h, null(), 0, RDW_FRAME | RDW_INVALIDATE);
}

unsafe extern "system" fn edit_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_NCCALCSIZE if l != 0 => {
            // A single-line field draws its text at the top: pad the client
            // area so the line sits in the middle.
            let r = DefSubclassProc(h, msg, w, l);
            let rc = &mut *(l as *mut RECT);
            let th = font_height(h);
            let extra = rc.bottom - rc.top - th;
            if th > 0 && extra > 1 && GetWindowLongW(h, GWL_STYLE) & ES_MULTILINE == 0 {
                rc.top += extra / 2;
                rc.bottom -= extra - extra / 2;
            }
            return r;
        }
        WM_NCPAINT => {
            let dc = GetWindowDC(h);
            let mut wr = RECT::default();
            GetWindowRect(h, &mut wr);
            let r = RECT { left: 0, top: 0, right: wr.right - wr.left, bottom: wr.bottom - wr.top };
            let mut cr = RECT::default();
            GetClientRect(h, &mut cr);
            MapWindowPoints(h, 0, &mut cr, 2);
            ExcludeClipRect(dc, cr.left - wr.left, cr.top - wr.top, cr.right - wr.left, cr.bottom - wr.top);
            fill(dc, &r, FIELD);
            frame(dc, &r, 1, if GetFocus() == h { ACCENT } else { LINE_STRONG });
            ReleaseDC(h, dc);
            return 0;
        }
        WM_SETFOCUS | WM_KILLFOCUS => {
            let r = DefSubclassProc(h, msg, w, l);
            RedrawWindow(h, null(), 0, RDW_FRAME | RDW_INVALIDATE);
            return r;
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(h, edit_proc, ID_EDIT);
        }
        _ => {}
    }
    DefSubclassProc(h, msg, w, l)
}

// ---------------------------------------------------------- progress bars

unsafe extern "system" fn progress_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = zeroed();
            let dc = BeginPaint(h, &mut ps);
            paint_progress(h, dc);
            EndPaint(h, &ps);
            return 0;
        }
        WM_PRINTCLIENT => {
            paint_progress(h, w as HDC);
            return 0;
        }
        WM_ERASEBKGND => return 1,
        PBM_SETPOS | PBM_DELTAPOS | PBM_STEPIT | PBM_SETRANGE | PBM_SETRANGE32 => {
            let r = DefSubclassProc(h, msg, w, l);
            InvalidateRect(h, null(), 0);
            return r;
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(h, progress_proc, ID_PROGRESS);
        }
        _ => {}
    }
    DefSubclassProc(h, msg, w, l)
}

/// The app's segmented meter: grey ticks, a solid green fill and a taller
/// marker on its end.
unsafe fn paint_progress(h: HWND, dc: HDC) {
    let mut rc = RECT::default();
    GetClientRect(h, &mut rc);
    let s = dpi_scale(h);
    let lo = SendMessageW(h, PBM_GETRANGE, 1, 0) as i32;
    let hi = SendMessageW(h, PBM_GETRANGE, 0, 0) as i32;
    let pos = SendMessageW(h, PBM_GETPOS, 0, 0) as i32;
    let frac = if hi > lo { ((pos - lo) as f32 / (hi - lo) as f32).clamp(0.0, 1.0) } else { 0.0 };

    buffered(dc, &rc, |dc, r| {
        fill(dc, r, BG);
        let width = r.right - r.left;
        let height = r.bottom - r.top;
        let track = px(8.0, s).min(height);
        let ty = r.top + (height - track) / 2;
        let tick = px(3.0, s);
        let pitch = px(5.0, s).max(tick + 1);
        let tb = CreateSolidBrush(TICK);
        let mut x = r.left;
        while x < r.right {
            let t = RECT { left: x, top: ty, right: (x + tick).min(r.right), bottom: ty + track };
            FillRect(dc, &t, tb);
            x += pitch;
        }
        DeleteObject(tb);
        if frac > 0.0 {
            let mark = px(3.0, s);
            let end = r.left + ((width as f32) * frac).round() as i32;
            let end = end.clamp(r.left + mark, r.right);
            fill(dc, &RECT { left: r.left, top: ty, right: end, bottom: ty + track }, ACCENT);
            fill(dc, &RECT { left: end - mark, top: r.top, right: end, bottom: r.bottom }, ACCENT);
        }
    });
}
