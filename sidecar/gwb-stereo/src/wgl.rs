//! The real device: a Win32 window, a pixel format with `PFD_STEREO` when the display has one, and
//! OpenGL 1.1. A window made with `visible: false` is never shown, which is how a test reaches the
//! real driver without putting anything on the desktop.

use crate::gl::*;
use std::cell::RefCell;
use std::collections::VecDeque;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::Graphics::OpenGL::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Event {
    Close,
    Resize(u32, u32),
    Drag(i32, i32),
    Wheel(i32),
    Key(u32),
}

thread_local! {
    static EVENTS: RefCell<VecDeque<Event>> = const { RefCell::new(VecDeque::new()) };
    static LAST: RefCell<Option<(i32, i32)>> = const { RefCell::new(None) };
}

fn push(e: Event) {
    EVENTS.with(|q| q.borrow_mut().push_back(e));
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let xy = || ((lp & 0xffff) as i16 as i32, ((lp >> 16) & 0xffff) as i16 as i32);
    match msg {
        WM_CLOSE => {
            push(Event::Close);
            0
        }
        WM_SIZE => {
            push(Event::Resize((lp & 0xffff) as u32, ((lp >> 16) & 0xffff) as u32));
            0
        }
        WM_LBUTTONDOWN => {
            LAST.with(|l| *l.borrow_mut() = Some(xy()));
            0
        }
        WM_LBUTTONUP => {
            LAST.with(|l| *l.borrow_mut() = None);
            0
        }
        WM_MOUSEMOVE => {
            let (x, y) = xy();
            LAST.with(|l| {
                let mut l = l.borrow_mut();
                if let Some((a, b)) = *l {
                    push(Event::Drag(x - a, y - b));
                    *l = Some((x, y));
                }
            });
            0
        }
        WM_MOUSEWHEEL => {
            push(Event::Wheel(((wp >> 16) & 0xffff) as i16 as i32));
            0
        }
        WM_KEYDOWN => {
            push(Event::Key(wp as u32));
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

pub struct Window {
    hwnd: HWND,
    hdc: HDC,
    hglrc: HGLRC,
    /// Pixel formats of this display with `PFD_STEREO`.
    pub stereo_formats: u32,
    placed: Option<(i32, i32, i32, i32)>,
}

fn descriptor() -> PIXELFORMATDESCRIPTOR {
    let mut p: PIXELFORMATDESCRIPTOR = unsafe { std::mem::zeroed() };
    p.nSize = std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16;
    p.nVersion = 1;
    p.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    p.iPixelType = PFD_TYPE_RGBA;
    p.cColorBits = 24;
    p.cAlphaBits = 8;
    p
}

/// The first accelerated stereo format, and how many there are. `ChoosePixelFormat` may answer a
/// stereo request with a mono format, so the list is read instead.
unsafe fn find_stereo(hdc: HDC) -> (Option<i32>, u32) {
    let size = std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u32;
    let mut p: PIXELFORMATDESCRIPTOR = unsafe { std::mem::zeroed() };
    let n = unsafe { DescribePixelFormat(hdc, 1, size, &mut p) };
    let (mut first, mut count) = (None, 0);
    let need = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER | PFD_STEREO;
    for i in 1..=n {
        if unsafe { DescribePixelFormat(hdc, i, size, &mut p) } == 0 {
            continue;
        }
        if p.dwFlags & need == need && p.iPixelType == PFD_TYPE_RGBA && p.cColorBits >= 24 {
            count += 1;
            first = first.or(Some(i));
        }
    }
    (first, count)
}

impl Window {
    pub fn create(title: &str, w: i32, h: i32, want_stereo: bool, visible: bool) -> Result<Window, String> {
        unsafe {
            let class = wide("GwbStereoViewer");
            let inst = GetModuleHandleW(std::ptr::null());
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.style = CS_OWNDC | CS_HREDRAW | CS_VREDRAW;
            wc.lpfnWndProc = Some(wndproc);
            wc.hInstance = inst;
            wc.lpszClassName = class.as_ptr();
            wc.hCursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
            RegisterClassW(&wc); // a second window of this process finds it registered
            let t = wide(title);
            // `w` and `h` are the drawing area: CreateWindow takes the size with its frame.
            let mut outer = RECT { left: 0, top: 0, right: w, bottom: h };
            AdjustWindowRectEx(&mut outer, WS_OVERLAPPEDWINDOW, 0, 0);
            let hwnd = CreateWindowExW(0, class.as_ptr(), t.as_ptr(), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, outer.right - outer.left, outer.bottom - outer.top, std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null());
            if hwnd.is_null() {
                return Err(format!("no window: {}", std::io::Error::last_os_error()));
            }
            let hdc = GetDC(hwnd);
            let (stereo, count) = find_stereo(hdc);
            let pfd = descriptor();
            let format = match stereo.filter(|_| want_stereo) {
                Some(i) => i,
                None => ChoosePixelFormat(hdc, &pfd),
            };
            if format == 0 || SetPixelFormat(hdc, format, &pfd) == 0 {
                return Err(format!("no OpenGL pixel format: {}", std::io::Error::last_os_error()));
            }
            let hglrc = wglCreateContext(hdc);
            if hglrc.is_null() || wglMakeCurrent(hdc, hglrc) == 0 {
                return Err(format!("no OpenGL context: {}", std::io::Error::last_os_error()));
            }
            if visible {
                ShowWindow(hwnd, SW_SHOW);
            }
            Ok(Window { hwnd, hdc, hglrc, stereo_formats: count, placed: None })
        }
    }

    /// Show the window without taking the keyboard from whoever has it: `--test-exit-after`.
    pub fn show_quietly(&self) {
        unsafe { ShowWindow(self.hwnd, SW_SHOWNOACTIVATE) };
    }

    pub fn swap(&self) {
        unsafe { SwapBuffers(self.hdc) };
    }

    pub fn set_title(&self, title: &str) {
        let t = wide(title);
        unsafe { SetWindowTextW(self.hwnd, t.as_ptr()) };
    }

    /// Quad-buffer displays often need the whole screen: F toggles it.
    pub fn toggle_fullscreen(&mut self) {
        unsafe {
            if let Some((x, y, w, h)) = self.placed.take() {
                SetWindowLongPtrW(self.hwnd, GWL_STYLE, (WS_OVERLAPPEDWINDOW | WS_VISIBLE) as isize);
                SetWindowPos(self.hwnd, std::ptr::null_mut(), x, y, w, h, SWP_FRAMECHANGED | SWP_NOZORDER);
                return;
            }
            let mut r: RECT = std::mem::zeroed();
            GetWindowRect(self.hwnd, &mut r);
            self.placed = Some((r.left, r.top, r.right - r.left, r.bottom - r.top));
            let (sw, sh) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
            SetWindowLongPtrW(self.hwnd, GWL_STYLE, (WS_POPUP | WS_VISIBLE) as isize);
            SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, sw, sh, SWP_FRAMECHANGED);
        }
    }

    /// Everything that has happened; `wait_ms` is how long to sleep if nothing has.
    pub fn events(&self, wait_ms: u32) -> Vec<Event> {
        unsafe {
            let mut m: MSG = std::mem::zeroed();
            if PeekMessageW(&mut m, std::ptr::null_mut(), 0, 0, PM_NOREMOVE) == 0 && wait_ms > 0 {
                MsgWaitForMultipleObjectsEx(0, std::ptr::null(), wait_ms, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            }
            while PeekMessageW(&mut m, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        }
        EVENTS.with(|q| q.borrow_mut().drain(..).collect())
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        unsafe {
            wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
            wglDeleteContext(self.hglrc);
            ReleaseDC(self.hwnd, self.hdc);
            DestroyWindow(self.hwnd);
        }
    }
}

const GL_RGBA8: i32 = 0x8058;
const GL_CLAMP_TO_EDGE: i32 = 0x812F;

/// The context current on this thread, through the `Gl` trait.
pub struct WglGl {
    view: [i32; 4],
}

impl WglGl {
    pub fn new() -> WglGl {
        unsafe {
            glEnable(GL_TEXTURE_2D);
            glDisable(GL_DEPTH_TEST);
            glDisable(GL_LIGHTING);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
            glPixelStorei(GL_PACK_ALIGNMENT, 1);
        }
        WglGl { view: [0, 0, 0, 0] }
    }
}

impl Default for WglGl {
    fn default() -> Self {
        WglGl::new()
    }
}

impl Gl for WglGl {
    fn viewport(&mut self, x: i32, y: i32, w: i32, h: i32) {
        self.view = [x, y, w, h];
        unsafe {
            glViewport(x, y, w, h);
            glMatrixMode(GL_PROJECTION);
            glLoadIdentity();
            glOrtho(0.0, w as f64, h as f64, 0.0, -1.0, 1.0);
            glMatrixMode(GL_MODELVIEW);
            glLoadIdentity();
        }
    }

    fn clear(&mut self, rgb: [f32; 3]) {
        unsafe {
            glClearColor(rgb[0], rgb[1], rgb[2], 1.0);
            glClear(GL_COLOR_BUFFER_BIT);
        }
    }

    fn draw_buffer(&mut self, buffer: u32) {
        unsafe { glDrawBuffer(buffer) };
    }

    fn color_mask(&mut self, r: bool, g: bool, b: bool) {
        unsafe { glColorMask(r as u8, g as u8, b as u8, 1) };
    }

    fn create_texture(&mut self, rgba: &[u8], w: u32, h: u32) -> u32 {
        let mut t = 0u32;
        unsafe {
            glGenTextures(1, &mut t);
            glBindTexture(GL_TEXTURE_2D, t);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR as i32);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR as i32);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w as i32, h as i32, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba.as_ptr() as *const _);
        }
        t
    }

    fn delete_texture(&mut self, tex: u32) {
        unsafe { glDeleteTextures(1, &tex) };
    }

    fn draw_quad(&mut self, q: &Quad) {
        let uv = [[0.0, 0.0], [q.uv[0], 0.0], [q.uv[0], q.uv[1]], [0.0, q.uv[1]]];
        unsafe {
            glBindTexture(GL_TEXTURE_2D, q.tex);
            glBegin(GL_QUADS);
            for i in 0..4 {
                glTexCoord2f(uv[i][0], uv[i][1]);
                glVertex2f(q.corners[i][0], q.corners[i][1]);
            }
            glEnd();
        }
    }

    fn error(&mut self) -> u32 {
        unsafe { glGetError() }
    }

    fn read(&mut self, buffer: u32, w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![0u8; (w * h * 4) as usize];
        unsafe {
            glReadBuffer(buffer);
            glReadPixels(0, 0, w as i32, h as i32, GL_RGBA, GL_UNSIGNED_BYTE, out.as_mut_ptr() as *mut _);
        }
        // OpenGL reads bottom row first.
        let row = w as usize * 4;
        let mut flipped = Vec::with_capacity(out.len());
        for r in out.chunks_exact(row).rev() {
            flipped.extend_from_slice(r);
        }
        flipped
    }

    fn stereo(&mut self) -> bool {
        let mut b = 0u8;
        unsafe { glGetBooleanv(GL_STEREO, &mut b) };
        b != 0
    }

    fn renderer(&mut self) -> String {
        unsafe {
            let p = glGetString(GL_RENDERER);
            if p.is_null() {
                return String::new();
            }
            std::ffi::CStr::from_ptr(p as *const _).to_string_lossy().into_owned()
        }
    }
}
