//! The native stereo viewer (REQ-GAP-33, SDP-2.3 GR-11): what a browser cannot do, a quad-buffer
//! pixel format, in a small program the sidecar starts and feeds over loopback.
//!
//! No stereo display exists on the machines this is built on, so the code is split where a test
//! can reach it. Everything that decides what goes into which colour buffer (`present`) is written
//! against the `Gl` trait, which has two implementations: the real OpenGL 1.1 calls (`wgl`), and
//! `soft`, a software GL with the four colour buffers of a stereo context and OpenGL's error rule
//! for a right buffer that does not exist. Only `SwapBuffers` and the choice of pixel format are out
//! of reach of the tests, and those are the hardware test (an owner item).

pub mod feed;
pub mod gl;
pub mod present;
pub mod scene;
pub mod soft;
pub mod viewer;
#[cfg(windows)]
pub mod wgl;
