// REQ-RUST-05: cap linear memory (core 256 MiB on the main thread, workers 1 GiB).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-cdylib-link-arg=--max-memory=268435456");
    }
}
