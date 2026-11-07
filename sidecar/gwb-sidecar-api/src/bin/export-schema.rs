//! Writes the sidecar API's JSON Schema to stdout (or to the path given), for the JS contract tests.
fn main() {
    let doc = gwb_sidecar_api::schema_document();
    let text = serde_json::to_string_pretty(&doc).expect("schema") + "\n";
    match std::env::args().nth(1) {
        Some(p) => std::fs::write(&p, text).expect("write schema"),
        None => print!("{text}"),
    }
}
