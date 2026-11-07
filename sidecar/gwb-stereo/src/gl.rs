//! The OpenGL the viewer uses: 1.1, no shaders, so it runs on the old workstation drivers that have
//! a quad-buffer pixel format.

pub const GL_NO_ERROR: u32 = 0;
pub const GL_INVALID_OPERATION: u32 = 0x0502;
pub const GL_FRONT_LEFT: u32 = 0x0400;
pub const GL_FRONT_RIGHT: u32 = 0x0401;
pub const GL_BACK_LEFT: u32 = 0x0402;
pub const GL_BACK_RIGHT: u32 = 0x0403;
pub const GL_BACK: u32 = 0x0405;

/// One textured parallelogram on the screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quad {
    pub tex: u32,
    /// Screen pixels, y down, in the order of the texture's corners (0,0), (u,0), (u,v), (0,v).
    pub corners: [[f32; 2]; 4],
    /// The part of the texture used: a tile at the image's edge holds padding beyond this.
    pub uv: [f32; 2],
}

pub trait Gl {
    /// `glViewport` and a matching orthographic projection: screen pixels, y down, within it.
    fn viewport(&mut self, x: i32, y: i32, w: i32, h: i32);
    fn clear(&mut self, rgb: [f32; 3]);
    fn draw_buffer(&mut self, buffer: u32);
    fn color_mask(&mut self, r: bool, g: bool, b: bool);
    fn create_texture(&mut self, rgba: &[u8], w: u32, h: u32) -> u32;
    fn delete_texture(&mut self, tex: u32);
    fn draw_quad(&mut self, q: &Quad);
    /// `glGetError`: the first error since the last call.
    fn error(&mut self) -> u32;
    /// `glReadBuffer` and `glReadPixels` of the rectangle at the window's lower left: RGBA, top row
    /// first. A buffer that does not exist gives an error and zeros.
    fn read(&mut self, buffer: u32, w: u32, h: u32) -> Vec<u8>;
    /// `GL_STEREO`: whether this context has left and right buffers.
    fn stereo(&mut self) -> bool;
    /// `GL_RENDERER`.
    fn renderer(&mut self) -> String;
}

pub fn buffer_name(b: u32) -> &'static str {
    match b {
        GL_BACK => "GL_BACK",
        GL_BACK_LEFT => "GL_BACK_LEFT",
        GL_BACK_RIGHT => "GL_BACK_RIGHT",
        GL_FRONT_LEFT => "GL_FRONT_LEFT",
        GL_FRONT_RIGHT => "GL_FRONT_RIGHT",
        _ => "other",
    }
}
