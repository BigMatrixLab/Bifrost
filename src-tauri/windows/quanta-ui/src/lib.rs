//! quanta_ui: an NSIS plugin that draws the installer's controls in the
//! Quanta app's style (src/styles.css, dark theme).
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
//!   quanta_ui::Init "<dir>"   load the Space Grotesk files in <dir>
//!                              (privately) and keep the plugin loaded
//!   quanta_ui::Skin <hwnd>     style the direct children of <hwnd>
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
struct PAINTSTRUCT {
    hdc: HDC,
    fErase: BOOL,
    rcPaint: RECT,
    fRestore: BOOL,
    fIncUpdate: BOOL,
    rgbReserved: [u8; 32],
}

#[repr(C)]
struct DRAWITEMSTRUCT {
    CtlType: u32,
    CtlID: u32,
    itemID: u32,
    itemAction: u32,
    itemState: u32,
    hwndItem: HWND,
    hDC: HDC,
    rcItem: RECT,
    itemData: usize,
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
const WM_DRAWITEM: u32 = 0x002B;
const WM_NCDESTROY: u32 = 0x0082;
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

const ODT_BUTTON: u32 = 4;
const ODS_SELECTED: u32 = 0x0001;
const ODS_DISABLED: u32 = 0x0004;
const ODS_FOCUS: u32 = 0x0010;
const ODS_NOFOCUSRECT: u32 = 0x0200;

const DT_CENTER: u32 = 0x0001;
const DT_VCENTER: u32 = 0x0004;
const DT_SINGLELINE: u32 = 0x0020;
const DT_END_ELLIPSIS: u32 = 0x8000;
const DT_HIDEPREFIX: u32 = 0x0010_0000;

const RDW_INVALIDATE: u32 = 0x0001;
const RDW_FRAME: u32 = 0x0400;
const SWP_FRAMECHANGED_ONLY: u32 = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020;
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
const ID_PARENT: usize = 0x5155_0002;
const ID_CHECK: usize = 0x5155_0003;
const ID_EDIT: usize = 0x5155_0004;
const ID_PROGRESS: usize = 0x5155_0005;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

thread_local! {
    static PROP_HOT: Vec<u16> = wide("QuantaHot");
    static PROP_BTN: Vec<u16> = wide("QuantaBtn");
    static PROP_MOVED: Vec<u16> = wide("QuantaMoved");
    static FONTS: RefCell<Vec<(i32, HGDIOBJ)>> = const { RefCell::new(Vec::new()) };
}

fn prop_hot() -> *const u16 {
    PROP_HOT.with(|p| p.as_ptr())
}
fn prop_btn() -> *const u16 {
    PROP_BTN.with(|p| p.as_ptr())
}
fn prop_moved() -> *const u16 {
    PROP_MOVED.with(|p| p.as_ptr())
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

/// `quanta_ui::Init "<font dir>"`: GDI+, the fonts, and staying loaded
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

/// `quanta_ui::Skin <hwnd>`: styles every direct child of the window.
#[no_mangle]
pub unsafe extern "C" fn Skin(_hwnd: HWND, _size: i32, _vars: *mut u16, stacktop: *mut *mut StackT, _extra: *mut ExtraParameters) {
    let Some(s) = pop_string(stacktop) else { return };
    let Ok(parent) = s.trim().parse::<i64>() else { return };
    let parent = parent as HWND;
    if IsWindow(parent) == 0 {
        return;
    }
    let mut child = GetWindow(parent, GW_CHILD);
    while child != 0 {
        skin(child);
        child = GetWindow(child, GW_HWNDNEXT);
    }
    space_back_button(parent);
}

/// NSIS places Back right against Next; with a filled Next button that
/// reads as one control, so Back moves left to leave a gap (once).
unsafe fn space_back_button(parent: HWND) {
    let back = GetDlgItem(parent, 3);
    let next = GetDlgItem(parent, 1);
    if back == 0 || next == 0 || GetPropW(back, prop_moved()) != 0 {
        return;
    }
    let mut b = RECT::default();
    let mut n = RECT::default();
    GetWindowRect(back, &mut b);
    GetWindowRect(next, &mut n);
    if b.right < n.left - 2 || b.top >= n.bottom || b.bottom <= n.top {
        return;
    }
    MapWindowPoints(0, parent, &mut b, 2);
    let gap = px(8.0, dpi_scale(parent));
    SetWindowPos(back, 0, b.left - gap, b.top, 0, 0, 0x0001 | 0x0004 | 0x0010); // no size, z-order, activation
    SetPropW(back, prop_moved(), 1);
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
    SetWindowLongW(h, GWL_STYLE, (style & !BS_TYPEMASK) | BS_OWNERDRAW);
    SetWindowSubclass(h, button_proc, ID_BUTTON, 0);
    let parent = GetParent(h);
    if parent != 0 {
        // Idempotent: the same id replaces nothing and adds nothing new.
        SetWindowSubclass(parent, parent_proc, ID_PARENT, 0);
    }
    InvalidateRect(h, null(), 0);
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
            InvalidateRect(h, null(), 0);
            return r;
        }
        WM_ERASEBKGND => return 1,
        WM_NCDESTROY => {
            RemovePropW(h, prop_hot());
            RemovePropW(h, prop_btn());
            RemovePropW(h, prop_moved());
            RemoveWindowSubclass(h, button_proc, ID_BUTTON);
        }
        _ => {}
    }
    DefSubclassProc(h, msg, w, l)
}

unsafe extern "system" fn parent_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
    if msg == WM_DRAWITEM && l != 0 {
        let di = &*(l as *const DRAWITEMSTRUCT);
        if di.CtlType == ODT_BUTTON && GetPropW(di.hwndItem, prop_btn()) != 0 {
            draw_button(di);
            return 1;
        }
    } else if msg == WM_NCDESTROY {
        RemoveWindowSubclass(h, parent_proc, ID_PARENT);
    }
    DefSubclassProc(h, msg, w, l)
}

unsafe fn draw_button(di: &DRAWITEMSTRUCT) {
    let h = di.hwndItem;
    let s = dpi_scale(h);
    let disabled = di.itemState & ODS_DISABLED != 0 || IsWindowEnabled(h) == 0;
    let pressed = di.itemState & ODS_SELECTED != 0;
    let hot = GetPropW(h, prop_hot()) != 0 && !disabled;
    let focused = di.itemState & ODS_FOCUS != 0 && di.itemState & ODS_NOFOCUSRECT == 0;
    // The main action: IDOK (Next / Install / Finish / Uninstall) on the
    // main window.
    let primary = GetDlgCtrlID(h) == 1;
    let label = button_label(&window_text(h));
    let font = label_font(h);

    buffered(di.hDC, &di.rcItem, |dc, r| {
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
        SetTextCharacterExtra(dc, px(1.3, s));
        let mut tr = *r;
        if pressed && !disabled {
            tr.top += 1;
            tr.bottom += 1;
        }
        DrawTextW(dc, label.as_ptr(), label.len() as i32, &mut tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_HIDEPREFIX);
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
        let size = px(15.0, s);
        let top = r.top + (r.bottom - r.top - size) / 2;
        let bx = RECT { left: r.left + px(1.0, s), top, right: r.left + px(1.0, s) + size, bottom: top + size };
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
            let gap = px(3.0, s);
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
    SetWindowPos(h, 0, 0, 0, 0, 0, SWP_FRAMECHANGED_ONLY);
    let m = px(8.0, dpi_scale(h)) as usize;
    SendMessageW(h, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, ((m << 16) | m) as isize);
    SetWindowSubclass(h, edit_proc, ID_EDIT, 0);
    RedrawWindow(h, null(), 0, RDW_FRAME | RDW_INVALIDATE);
}

unsafe extern "system" fn edit_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_NCPAINT => {
            let dc = GetWindowDC(h);
            let mut wr = RECT::default();
            GetWindowRect(h, &mut wr);
            let r = RECT { left: 0, top: 0, right: wr.right - wr.left, bottom: wr.bottom - wr.top };
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
