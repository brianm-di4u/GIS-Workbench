//! Dev tool for the FX-09 generator: `cargo run --release -p gw-pointcloud --example las2laz in.las out.laz`.
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let b = std::fs::read(&a[1]).expect("read");
    let z = gw_pointcloud::las_to_laz(&b).unwrap_or_else(|e| panic!("{}", e.msg));
    std::fs::write(&a[2], z).expect("write");
}
