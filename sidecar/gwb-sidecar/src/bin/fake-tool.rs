//! Test double for the bundled tools (security suite, SDP-2.1 §7.3). Installed into a temporary
//! modules folder under every tool name; what it does is read from the first line of its input
//! file (the second-to-last argument), so tests drive it through ordinary uploads:
//!   OK                 write the output, print GDAL-style progress
//!   SLEEP <s>          run for s seconds, printing progress
//!   SPAWN <pidfile>    start a grandchild, write both PIDs, then sleep (cancel must kill both)
//!   FAIL               write a partial output, then exit 3
//!   WRITE <bytes>      write that many bytes to the output in 1 MB steps
//!   ALLOC <mb>         allocate and touch that much memory
//!   ECHOARGS <file>    write the argument array (one per line) to <file>, then OK
//!   VIEW <driver> <w> <h> <bands> <type>   a raster for the view tests: `-json` describes it,
//!                      `-of GTiff` writes a one-pixel TIFF, `-of ENVI` writes the window, each
//!                      sample being (x + 2 y + 3 band) mod 251 of its full-resolution position.
//!                      A second line `DIE` fails every read; `SLOW <ms>` waits first.
use std::io::Write;
use std::time::Duration;

/// The VIEW verb (see above): true when it handled the run.
fn view(args: &[String]) -> bool {
    let n = args.len();
    let json = args.iter().any(|a| a == "-json");
    let input = if json { n.checked_sub(1) } else { n.checked_sub(2) };
    let Some(text) = input.and_then(|i| std::fs::read_to_string(&args[i]).ok()) else { return false };
    let f: Vec<&str> = text.lines().next().unwrap_or("").split_whitespace().collect();
    if f.first() != Some(&"VIEW") || f.len() < 6 {
        return false;
    }
    let (w, h, bands): (u64, u64, u64) = (f[2].parse().unwrap(), f[3].parse().unwrap(), f[4].parse().unwrap());
    if json {
        let b: Vec<String> = (1..=bands).map(|i| format!("{{\"band\":{i},\"type\":\"{}\"}}", f[5])).collect();
        println!("{{\"driverShortName\":\"{}\",\"size\":[{w},{h}],\"bands\":[{}]}}", f[1], b.join(","));
        return true;
    }
    let opt = |k: &str, c: usize| args.iter().position(|a| a == k).map(|i| args[i + 1..=i + c].iter().map(|v| v.parse::<u64>().unwrap_or(0)).collect::<Vec<u64>>());
    let out = &args[n - 1];
    if args.iter().any(|a| a == "GTiff") {
        // Header, one tag (GDAL_NODATA "7"), no pixel data: all a view reads of it.
        let mut b = b"II\x2a\0\x08\0\0\0\x01\0".to_vec();
        b.extend_from_slice(&42113u16.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(b"7\0\0\0\0\0\0\0");
        std::fs::write(out, b).unwrap();
        return true;
    }
    if text.lines().nth(1) == Some("DIE") {
        std::process::exit(9);
    }
    if let Some(s) = text.lines().nth(1).and_then(|l| l.strip_prefix("SLOW ")) {
        std::thread::sleep(Duration::from_millis(s.trim().parse().unwrap()));
    }
    let win = opt("-srcwin", 4).unwrap();
    let size = opt("-outsize", 2).unwrap_or(vec![win[2], win[3]]);
    let (sx, sy) = (win[2].div_ceil(size[0].max(1)), win[3].div_ceil(size[1].max(1)));
    let mut b = Vec::with_capacity((size[0] * size[1] * bands) as usize);
    for y in 0..size[1] {
        for x in 0..size[0] {
            for k in 0..bands {
                b.push(((win[0] + x * sx + 2 * (win[1] + y * sy) + 3 * k) % 251) as u8);
            }
        }
    }
    std::fs::write(out, b).unwrap();
    true
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Stands in for the stereo viewer in the route tests: with the device `soft-mono` it fails at
    // once, as a viewer that cannot start; otherwise it stays until it is killed.
    if args.first().map(|s| s.as_str()) == Some("--sidecar") && args.iter().any(|a| a == "soft-mono") {
        eprintln!("gwb-stereo-viewer: no OpenGL pixel format");
        std::process::exit(7);
    }
    // Stands in for a browser that never answers on its DevTools pipe, in the gwb-run tests.
    let browser = args.iter().any(|a| a == "--remote-debugging-pipe");
    if browser || args.first().map(|s| s.as_str()) == Some("--child") || args.first().map(|s| s.as_str()) == Some("--sidecar") {
        std::thread::sleep(Duration::from_secs(300));
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-version") {
        println!("GDAL 9.9.9 \"fake\", released 2099/01/01");
        return;
    }
    if args.iter().any(|a| a == "--formats") {
        println!("Supported Formats: (ro:read-only, rw:read-write, +:write from scratch)");
        println!("  GTiff -raster,vector- (rw+uvs): GeoTIFF (*.tif, *.tiff)");
        println!("  COG -raster- (w+v): Cloud optimized GeoTIFF generator (*.tif, *.tiff)");
        println!("  GPKG -raster,vector- (rw+uvs): GeoPackage (*.gpkg)");
        println!("  MrSID -raster- (rov): Multi-resolution Seamless Image Database (MrSID) (*.sid)");
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--format") {
        let _ = args.get(i + 1);
        println!("<CreationOptionList><Option name='COMPRESS' type='string-select'><Value>NONE</Value><Value>LZW</Value><Value>DEFLATE</Value></Option><Option name='ZLEVEL' type='int' min='1' max='9'/><Option name='TITLE' type='string'/></CreationOptionList>");
        println!("<LayerCreationOptionList><Option name='FID' type='string'/></LayerCreationOptionList>");
        return;
    }
    if view(&args) {
        return;
    }
    if args.iter().any(|a| a == "-json") {
        println!("{{\"driverShortName\":\"GTiff\",\"driverLongName\":\"GeoTIFF\",\"size\":[10,10],\"bands\":[{{\"band\":1}}]}}");
        return;
    }
    if args.iter().all(|a| a.starts_with('-')) {
        println!("[]");
        return;
    }
    let n = args.len();
    if n < 2 {
        std::process::exit(2);
    }
    let input = &args[n - 2];
    let output = &args[n - 1];
    let cmd = std::fs::read_to_string(input).unwrap_or_default();
    let mut it = cmd.lines().next().unwrap_or("").split_whitespace();
    let verb = it.next().unwrap_or("OK");
    let arg = it.next().unwrap_or("");
    let progress = |p: u32| {
        print!("{p}...");
        let _ = std::io::stdout().flush();
    };
    match verb {
        "SLEEP" => {
            let s: u64 = arg.parse().unwrap_or(1);
            for i in 0..(s * 10) {
                if i % 10 == 0 {
                    progress(((i * 100) / (s * 10)) as u32);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            std::fs::write(output, b"slept").unwrap();
            println!("100 - done.");
        }
        "SPAWN" => {
            let me = std::env::current_exe().unwrap();
            // Never waited on, on purpose: the test checks that cancelling kills the whole tree.
            #[allow(clippy::zombie_processes)]
            let child = std::process::Command::new(me).arg("--child").spawn().unwrap();
            std::fs::write(arg, format!("{}\n{}\n", std::process::id(), child.id())).unwrap();
            std::thread::sleep(Duration::from_secs(300));
        }
        "FAIL" => {
            std::fs::write(output, b"partial").unwrap();
            eprintln!("ERROR 1: fake failure");
            std::process::exit(3);
        }
        "WRITE" => {
            let total: u64 = arg.parse().unwrap_or(0);
            let mut f = std::fs::File::create(output).unwrap();
            let chunk = vec![7u8; 1 << 20];
            let mut done = 0;
            while done < total {
                let k = chunk.len().min((total - done) as usize);
                f.write_all(&chunk[..k]).unwrap();
                f.flush().unwrap();
                done += k as u64;
                std::thread::sleep(Duration::from_millis(30));
            }
            println!("100 - done.");
        }
        "ALLOC" => {
            let mb: usize = arg.parse().unwrap_or(1);
            let mut v: Vec<Vec<u8>> = Vec::new();
            for _ in 0..mb {
                let mut b = Vec::new();
                if b.try_reserve_exact(1 << 20).is_err() {
                    eprintln!("ERROR 2: out of memory");
                    std::process::exit(4);
                }
                b.resize(1 << 20, 1);
                v.push(b);
            }
            std::fs::write(output, format!("{}", v.len())).unwrap();
        }
        "ECHOARGS" => {
            std::fs::write(arg, args.join("\n")).unwrap();
            std::fs::write(output, b"ok").unwrap();
        }
        _ => {
            progress(0);
            progress(50);
            std::fs::write(output, b"fake-output").unwrap();
            println!("100 - done.");
        }
    }
}
