fn main() {
    let p = std::env::args().nth(1).unwrap();
    let tag = std::env::args().nth(2).unwrap();
    let b = std::fs::read(&p).unwrap();
    let i = b.windows(tag.len()).position(|w| w == tag.as_bytes()).unwrap();
    let len: usize = std::str::from_utf8(&b[i + 6..i + 11]).unwrap().parse().unwrap();
    let data = &b[i + 11..i + 11 + len];
    let (f, complete, err) = gw_parse::tre::decode(&tag, data);
    println!("complete {complete} err {err:?} fields {}", f.len());
    for (k, v) in f.iter().take(40) {
        println!("{k} = {v:?}");
    }
}
