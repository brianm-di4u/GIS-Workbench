// Linux: the soname GDAL's DT_NEEDED names.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-soname,libspatialite.so.8");
    }
}
