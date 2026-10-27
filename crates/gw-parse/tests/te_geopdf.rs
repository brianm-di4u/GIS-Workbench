//! TE-001 / TE-007 regression on real USGS US Topo GeoPDFs from the T&E corpus
//! (build/campaign/corpus.json; skipped when TE-corpus is not present).
//! Current US Topo: viewport and CRS inside compressed object streams, images on the page with
//! ASCII85 + Flate/DCT chains. 2012 US Topo: LGIDict georeferencing, images inside a Form XObject.

use gw_parse::pdf::{to_json, Pdf};
use std::path::PathBuf;

fn corpus(rel: &str) -> Option<Vec<u8>> {
    let root = std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"));
    std::fs::read(root.join(rel)).ok()
}

#[test]
fn te001_current_us_topo_viewport_from_object_streams() {
    let Some(b) = corpus("geopdf-ustopo-vinehill-honkerbay-current/CA_Vine_Hill_20211231_TM_geo.pdf") else {
        eprintln!("TE-corpus not present; skipped");
        return;
    };
    let js = to_json(&Pdf::scan(&b).unwrap()).unwrap();
    assert!(js.contains("\"gpts\":[37.9828,-122.14729"), "map viewport GPTS not found");
    assert!(js.contains("North American 1983 UTM Zone 10N"), "GCS WKT not found");
    assert!(js.contains("\"filters\":[\"ASCII85Decode\",\"DCTDecode\"]"), "filter chain not reported");
    assert!(js.contains("\"contents\":[{"), "content streams not listed");
}

#[test]
fn te007_2012_us_topo_lgidict_and_form_images() {
    let Some(b) = corpus("geopdf-ustopo-vinehill-2012/CA_Vine_Hill_20120213_TM_geo.pdf") else {
        eprintln!("TE-corpus not present; skipped");
        return;
    };
    let js = to_json(&Pdf::scan(&b).unwrap()).unwrap();
    assert!(js.contains("\"name\":\"Fm1/Im0\""), "images inside Form XObject Fm1 not found");
    assert!(js.contains("\"smask\":{"), "soft masks not reported");
    assert!(js.contains("\"lgi\":[{"), "LGIDict not reported");
    assert!(js.contains("\"ProjectionType\":\"UT\""), "{}", &js[js.find("\"lgi\"").unwrap_or(0)..][..400.min(js.len() - js.find("\"lgi\"").unwrap_or(0))]);
}
