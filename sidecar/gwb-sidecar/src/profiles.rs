//! Fixed job profiles (REQ-SDC-04, REQ-SDC-08, SDP-2.1 §3.6). The TOML files under
//! `sidecar/profiles/` are compiled into the binary: nothing at run time can add a tool or change
//! an argument template. A request names a profile and gives option values; each value is checked
//! against the option's type and range and substituted into single elements of an argument array
//! (no shell, no word splitting), so a value can never become a second argument or a command.

use gwb_sidecar_api::{DataKind, OptionKind, OptionSpec, ProfileInfo};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub const EMBEDDED: &[(&str, &str)] = &[
    ("raster-cog", include_str!("../../profiles/raster-cog.toml")),
    ("raster-jp2", include_str!("../../profiles/raster-jp2.toml")),
    ("raster-vrt-cog", include_str!("../../profiles/raster-vrt-cog.toml")),
    ("vector-gpkg", include_str!("../../profiles/vector-gpkg.toml")),
    ("vector-fgb", include_str!("../../profiles/vector-fgb.toml")),
    ("vector-parquet", include_str!("../../profiles/vector-parquet.toml")),
    ("export-gdal", include_str!("../../profiles/export-gdal.toml")),
    ("export-ogr", include_str!("../../profiles/export-ogr.toml")),
    ("probe", include_str!("../../profiles/probe.toml")),
    ("points-copc", include_str!("../../profiles/points-copc.toml")),
    #[cfg(windows)]
    ("video-h264-klv", include_str!("../../profiles/video-h264-klv.toml")),
    // Linux: the same id, MPEG-1 output (no licensed H.264 encoder there; profiles/linux/).
    #[cfg(not(windows))]
    ("video-h264-klv", include_str!("../../profiles/linux/video-h264-klv.toml")),
    // Linux with Cisco's OpenH264 installed (REQ-GAP-51).
    #[cfg(not(windows))]
    ("video-h264-openh264", include_str!("../../profiles/linux/video-h264-openh264.toml")),
    ("raster-pansharpen", include_str!("../../profiles/raster-pansharpen.toml")),
    ("raster-reproject", include_str!("../../profiles/raster-reproject.toml")),
    ("raster-sds-cog", include_str!("../../profiles/raster-sds-cog.toml")),
    ("raster-tiledb", include_str!("../../profiles/raster-tiledb.toml")),
    ("pdf-cog", include_str!("../../profiles/pdf-cog.toml")),
    ("gdb-catalogue", include_str!("../../profiles/gdb-catalogue.toml")),
    ("pgraster-cog", include_str!("../../profiles/pgraster-cog.toml")),
    ("model-fbx", include_str!("../../profiles/model-fbx.toml")),
    ("model-ifc", include_str!("../../profiles/model-ifc.toml")),
    ("model-multipatch", include_str!("../../profiles/model-multipatch.toml")),
    ("model-multipatch-shp", include_str!("../../profiles/model-multipatch-shp.toml")),
    ("ossim-rpc", include_str!("../../profiles/ossim-rpc.toml")),
    ("sfm-block", include_str!("../../profiles/sfm-block.toml")),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub title: String,
    pub module: String,
    pub input: DataKind,
    #[serde(default = "one")]
    pub min_inputs: u32,
    #[serde(default = "one")]
    pub max_inputs: u32,
    /// Output extension; empty when the result is JSON (`probe`).
    #[serde(default)]
    pub output_ext: String,
    /// How the output is named: `{stem}` is the first input's name without its extension.
    #[serde(default = "default_output_name")]
    pub output_name: String,
    #[serde(default)]
    pub extra_outputs: Vec<String>,
    #[serde(default = "default_time")]
    pub time_limit_s: u64,
    #[serde(default = "default_cpu")]
    pub cpu_limit_s: u64,
    #[serde(default = "default_mem")]
    pub memory_mb: u64,
    #[serde(default = "default_procs")]
    pub processes: u32,
    /// Whether an XML "pointer" input (VRT and similar) is acceptable. Only profiles that build
    /// their own VRT set this; uploaded VRTs could point at any local file or URL.
    #[serde(default)]
    pub allow_pointer_inputs: bool,
    /// Whether a picked folder is acceptable as an input (a FileGDB `.gdb`).
    #[serde(default)]
    pub allow_dir_inputs: bool,
    /// A switch that must be open for the profile to run (`database`: OD-2.17, the tool would open
    /// a network connection). Closed in every shipped build.
    pub gate: Option<String>,
    /// Modules that must be installed as well as `module` (`available` in the caps says so).
    #[serde(default)]
    pub requires: Vec<String>,
    /// Pack this folder of the job's temporary files into `{output}` after the last step.
    pub zip_dir: Option<String>,
    #[serde(default)]
    pub options: Vec<OptSpec>,
    pub steps: Vec<Step>,
}

fn one() -> u32 {
    1
}
fn default_output_name() -> String {
    "{stem}".into()
}
fn default_time() -> u64 {
    6 * 3600
}
fn default_cpu() -> u64 {
    24 * 3600
}
fn default_mem() -> u64 {
    8192
}
fn default_procs() -> u32 {
    4
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptSpec {
    pub name: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: OptionKind,
    #[serde(default)]
    pub values: Vec<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub default: Option<toml::Value>,
    #[serde(default)]
    pub optional: bool,
    /// For `creation_options`: the option holding the driver they belong to.
    pub driver_option: Option<String>,
    /// For `creation_options`: the flag each item follows (`-co`, `-lco`, `-dsco`).
    pub flag: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub tool: String,
    pub args: Vec<Arg>,
    /// `gdal` (0...10...100 - done.), `ffmpeg` (-progress pipe:1), `lines` (`PROGRESS <0..1>`), `none`.
    #[serde(default = "none")]
    pub progress: String,
    /// Share of the whole job's progress this step covers (default: equal shares).
    pub weight: Option<f64>,
    /// For `probe`: capture stdout as JSON under this key of the result; a failure is not fatal.
    pub capture: Option<String>,
    #[serde(default)]
    pub optional: bool,
    /// Run only when this option is set (bool true, or any value).
    pub when: Option<String>,
}

fn none() -> String {
    "none".into()
}

/// An argument: a literal/template string, or a group included only when an option is set.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Arg {
    Text(String),
    When {
        when: String,
        #[serde(default)]
        equals: Option<String>,
        args: Vec<String>,
    },
    Each {
        each: String,
        args: Vec<String>,
    },
    /// Repeated for every input from index `each_input` on, with `{item}` the input's path.
    EachInput {
        each_input: usize,
        args: Vec<String>,
    },
}

/// A checked option value.
#[derive(Debug, Clone, PartialEq)]
pub enum OptVal {
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    List(Vec<String>),
}

impl OptVal {
    pub fn render(&self) -> String {
        match self {
            OptVal::Text(s) => s.clone(),
            OptVal::Int(i) => i.to_string(),
            OptVal::Float(f) => {
                let s = format!("{f}");
                if s.contains('e') || s.contains("inf") || s.contains("NaN") {
                    format!("{f:.6}")
                } else {
                    s
                }
            }
            OptVal::Bool(b) => if *b { "YES" } else { "NO" }.into(),
            OptVal::List(v) => v.join(","),
        }
    }
    pub fn to_json(&self) -> Value {
        match self {
            OptVal::Text(s) => Value::String(s.clone()),
            OptVal::Int(i) => Value::from(*i),
            OptVal::Float(f) => Value::from(*f),
            OptVal::Bool(b) => Value::Bool(*b),
            OptVal::List(v) => Value::from(v.clone()),
        }
    }
    fn is_set(&self) -> bool {
        !matches!(self, OptVal::Bool(false)) && !matches!(self, OptVal::List(v) if v.is_empty())
    }
}

/// What option validation needs to know about the installed GDAL (from the caps).
pub trait DriverInfo {
    fn raster_writer(&self, name: &str) -> bool;
    fn vector_writer(&self, name: &str) -> bool;
    /// The driver's creation options; `None` if unknown (then items are refused).
    fn creation_options(&self, driver: &str, flag: &str) -> Option<Vec<gwb_sidecar_api::CreationOption>>;
}

pub fn load_all() -> Result<Vec<Profile>, String> {
    let mut out = Vec::new();
    for (id, text) in EMBEDDED {
        let p: Profile = toml::from_str(text).map_err(|e| format!("profile {id}: {e}"))?;
        if p.id != *id {
            return Err(format!("profile {id}: id is {}", p.id));
        }
        validate_profile(&p)?;
        out.push(p);
    }
    Ok(out)
}

/// Template sanity: every `{name}` is an option or a built-in placeholder.
fn validate_profile(p: &Profile) -> Result<(), String> {
    let names: Vec<&str> = p.options.iter().map(|o| o.name.as_str()).collect();
    let builtin = ["input", "output", "outdir", "workdir", "provenance", "stem", "list", "tmp", "item", "script", "inputdir", "modules", "sds", "sds_args"];
    let check = |s: &str| -> Result<(), String> {
        for ph in placeholders(s) {
            let base = ph.split(':').next().unwrap_or("");
            if !builtin.contains(&base) && !names.contains(&base) {
                return Err(format!("profile {}: unknown placeholder {{{ph}}}", p.id));
            }
        }
        Ok(())
    };
    for s in &p.steps {
        for a in &s.args {
            match a {
                Arg::Text(t) => check(t)?,
                Arg::When { when, args, .. } | Arg::Each { each: when, args } => {
                    if !names.contains(&when.as_str()) {
                        return Err(format!("profile {}: condition on unknown option {when}", p.id));
                    }
                    for t in args {
                        check(t)?;
                    }
                }
                Arg::EachInput { args, .. } => {
                    for t in args {
                        check(t)?;
                    }
                }
            }
        }
    }
    if let Some(g) = &p.gate {
        if g != "database" {
            return Err(format!("profile {}: unknown gate {g}", p.id));
        }
    }
    for m in &p.requires {
        if crate::modules::def(m).is_none() {
            return Err(format!("profile {}: requires an unknown module {m}", p.id));
        }
    }
    if let Some(z) = &p.zip_dir {
        crate::paths::safe_name(z).map_err(|e| format!("profile {}: zip_dir: {e}", p.id))?;
    }
    // jobs.rs expands {stem} in the output name and nothing else.
    if p.output_name.replace("{stem}", "").contains('{') {
        return Err(format!("profile {}: output_name takes only {{stem}}", p.id));
    }
    for o in &p.options {
        if o.kind == OptionKind::Enum && o.values.is_empty() {
            return Err(format!("profile {}: enum {} has no values", p.id, o.name));
        }
        if o.kind == OptionKind::CreationOptions && (o.driver_option.is_none() || o.flag.is_none()) {
            return Err(format!("profile {}: creation options {} need driver_option and flag", p.id, o.name));
        }
    }
    Ok(())
}

fn placeholders(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find('{') {
        match rest[i..].find('}') {
            Some(j) => {
                out.push(rest[i + 1..i + j].to_string());
                rest = &rest[i + j + 1..];
            }
            None => break,
        }
    }
    out
}

impl Profile {
    pub fn info(&self, available: bool) -> ProfileInfo {
        ProfileInfo {
            id: self.id.clone(),
            title: self.title.clone(),
            module: self.module.clone(),
            input: self.input,
            min_inputs: self.min_inputs,
            max_inputs: self.max_inputs,
            output_ext: self.output_ext.clone(),
            options: self
                .options
                .iter()
                .map(|o| OptionSpec { name: o.name.clone(), title: o.title.clone(), kind: o.kind, values: o.values.clone(), min: o.min, max: o.max, default: o.default.as_ref().map(toml_to_json), optional: o.optional })
                .collect(),
            available,
            tools: self.steps.iter().map(|s| s.tool.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect(),
        }
    }

    /// Check request options against the profile. Unknown names, wrong types and values out of
    /// range are refused with a message naming the option.
    pub fn check_options(&self, req: &BTreeMap<String, Value>, drivers: &dyn DriverInfo) -> Result<BTreeMap<String, OptVal>, String> {
        for k in req.keys() {
            if !self.options.iter().any(|o| &o.name == k) {
                return Err(format!("option {k:?} is not part of profile {}", self.id));
            }
        }
        let mut out = BTreeMap::new();
        // Drivers first: creation options are checked against the chosen driver.
        let mut order: Vec<&OptSpec> = self.options.iter().collect();
        order.sort_by_key(|o| (o.kind == OptionKind::CreationOptions) as u8);
        for o in order {
            let v = match req.get(&o.name) {
                Some(Value::Null) | None => match &o.default {
                    Some(d) => toml_to_json(d),
                    None if o.optional || o.kind == OptionKind::Bool || o.kind == OptionKind::CreationOptions => continue,
                    None => return Err(format!("option {} is required", o.name)),
                },
                Some(v) => v.clone(),
            };
            let val = check_one(o, &v, &out, drivers).map_err(|e| format!("option {}: {e}", o.name))?;
            out.insert(o.name.clone(), val);
        }
        Ok(out)
    }

    /// The argument array of one step.
    pub fn expand(&self, step: &Step, ctx: &ExpandCtx, opts: &BTreeMap<String, OptVal>) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for a in &step.args {
            match a {
                Arg::Text(t) if t == "{sds_args}" => out.extend(ctx.sds_args.iter().cloned()),
                Arg::Text(t) => out.push(subst(t, ctx, opts, None)?),
                Arg::When { when, equals, args } => {
                    let hit = match (opts.get(when), equals) {
                        (Some(v), Some(eq)) => v.render() == *eq,
                        (Some(v), None) => v.is_set(),
                        (None, _) => false,
                    };
                    if hit {
                        for t in args {
                            out.push(subst(t, ctx, opts, None)?);
                        }
                    }
                }
                Arg::Each { each, args } => {
                    if let Some(OptVal::List(items)) = opts.get(each) {
                        for it in items {
                            for t in args {
                                out.push(subst(t, ctx, opts, Some(it))?);
                            }
                        }
                    }
                }
                Arg::EachInput { each_input, args } => {
                    for it in ctx.inputs.iter().skip(*each_input) {
                        for t in args {
                            out.push(subst(t, ctx, opts, Some(it))?);
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn step_runs(&self, step: &Step, opts: &BTreeMap<String, OptVal>) -> bool {
        match &step.when {
            None => true,
            Some(w) => opts.get(w).map(|v| v.is_set()).unwrap_or(false),
        }
    }
}

pub struct ExpandCtx {
    pub inputs: Vec<String>,
    pub output: String,
    pub workdir: String,
    pub provenance: String,
    pub stem: String,
    pub list: String,
    pub script_dir: String,
    pub modules_dir: String,
    /// The subdataset the `subdataset` option names, once a step has captured GDAL's report.
    pub sds: String,
    /// Arguments that GDAL's report on that subdataset calls for (jobs.rs). `{sds_args}`, as a whole
    /// argument, stands for all of them, or for none.
    pub sds_args: Vec<String>,
}

fn subst(t: &str, ctx: &ExpandCtx, opts: &BTreeMap<String, OptVal>, item: Option<&str>) -> Result<String, String> {
    let mut s = String::new();
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        s.push_str(&rest[..i]);
        let j = rest[i..].find('}').ok_or_else(|| format!("unclosed placeholder in {t:?}"))?;
        let ph = &rest[i + 1..i + j];
        let v = match ph {
            "input" => ctx.inputs.first().cloned().unwrap_or_default(),
            "output" => ctx.output.clone(),
            // Where further outputs go: every file in this folder is published with the job.
            "outdir" => std::path::Path::new(&ctx.output).parent().map(|p| p.display().to_string()).unwrap_or_default(),
            "workdir" => ctx.workdir.clone(),
            "provenance" => ctx.provenance.clone(),
            "stem" => ctx.stem.clone(),
            "list" => ctx.list.clone(),
            "modules" => ctx.modules_dir.clone(),
            "sds" => ctx.sds.clone(),
            "inputdir" => std::path::Path::new(ctx.inputs.first().map(String::as_str).unwrap_or("")).parent().map(|p| p.display().to_string()).unwrap_or_default(),
            "item" => item.ok_or("{item} outside an each group")?.to_string(),
            _ if ph.starts_with("tmp:") => {
                let name = crate::paths::safe_name(&ph[4..]).map_err(|e| e.to_string())?;
                std::path::Path::new(&ctx.workdir).join(name).display().to_string()
            }
            _ if ph.starts_with("script:") => {
                let name = crate::paths::safe_name(&ph[7..]).map_err(|e| e.to_string())?;
                std::path::Path::new(&ctx.script_dir).join(name).display().to_string()
            }
            name => opts.get(name).map(|v| v.render()).unwrap_or_default(),
        };
        s.push_str(&v);
        rest = &rest[i + j + 1..];
    }
    s.push_str(rest);
    Ok(s)
}

pub fn toml_to_json(v: &toml::Value) -> Value {
    match v {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => Value::from(*i),
        toml::Value::Float(f) => Value::from(*f),
        toml::Value::Boolean(b) => Value::Bool(*b),
        toml::Value::Array(a) => Value::Array(a.iter().map(toml_to_json).collect()),
        _ => Value::Null,
    }
}

const DRIVER_RE_MAX: usize = 40;

fn plain_token(s: &str, max: usize, extra: &[char]) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || extra.contains(&c))
}

fn check_one(o: &OptSpec, v: &Value, prior: &BTreeMap<String, OptVal>, drivers: &dyn DriverInfo) -> Result<OptVal, String> {
    let range = |x: f64| -> Result<(), String> {
        if !x.is_finite() {
            return Err("not a finite number".into());
        }
        if let Some(m) = o.min {
            if x < m {
                return Err(format!("{x} is below {m}"));
            }
        }
        if let Some(m) = o.max {
            if x > m {
                return Err(format!("{x} is above {m}"));
            }
        }
        Ok(())
    };
    match o.kind {
        OptionKind::Enum => {
            let s = v.as_str().ok_or("must be one of the listed values")?;
            if o.values.iter().any(|x| x == s) {
                Ok(OptVal::Text(s.to_string()))
            } else {
                Err(format!("{s:?} is not one of {}", o.values.join(", ")))
            }
        }
        OptionKind::Int => {
            let i = v.as_i64().ok_or("must be a whole number")?;
            range(i as f64)?;
            Ok(OptVal::Int(i))
        }
        OptionKind::Float => {
            let f = v.as_f64().ok_or("must be a number")?;
            range(f)?;
            Ok(OptVal::Float(f))
        }
        OptionKind::Bool => Ok(OptVal::Bool(v.as_bool().ok_or("must be true or false")?)),
        OptionKind::RasterDriver | OptionKind::VectorDriver => {
            let s = v.as_str().ok_or("must be a driver name")?;
            if !plain_token(s, DRIVER_RE_MAX, &['-', ' ']) {
                return Err(format!("{s:?} is not a driver name"));
            }
            let ok = if o.kind == OptionKind::RasterDriver { drivers.raster_writer(s) } else { drivers.vector_writer(s) };
            if !ok {
                return Err(format!("{s} is not a writer the sidecar's GDAL offers"));
            }
            Ok(OptVal::Text(s.to_string()))
        }
        OptionKind::Crs => {
            let s = v.as_str().ok_or("must be EPSG:<code>")?;
            let rest = s.strip_prefix("EPSG:").ok_or("must be EPSG:<code>")?;
            let (h, vert) = match rest.split_once('+') {
                Some((h, v)) => (h, Some(v)),
                None => (rest, None),
            };
            let code = |c: &str| -> Result<u32, String> {
                let n = c.parse::<u32>().map_err(|_| "must be EPSG:<code>".to_string())?;
                if !(1024..=999_999).contains(&n) {
                    return Err("EPSG code out of range".into());
                }
                Ok(n)
            };
            let h = code(h)?;
            Ok(OptVal::Text(match vert {
                Some(v) => format!("EPSG:{h}+{}", code(v)?),
                None => format!("EPSG:{h}"),
            }))
        }
        OptionKind::FloatList => {
            let arr = v.as_array().ok_or("must be a list of numbers")?;
            if arr.is_empty() || arr.len() > 64 {
                return Err("must hold 1 to 64 numbers".into());
            }
            let mut items = Vec::new();
            for it in arr {
                let f = it.as_f64().ok_or("must be a list of numbers")?;
                range(f)?;
                items.push(OptVal::Float(f).render());
            }
            Ok(OptVal::List(items))
        }
        OptionKind::Name => {
            let s = v.as_str().ok_or("must be a name")?;
            if !plain_token(s, 63, &['-', '.']) || s.starts_with('-') {
                return Err(format!("{s:?} is not a plain name"));
            }
            Ok(OptVal::Text(s.to_string()))
        }
        OptionKind::CreationOptions => {
            let arr = v.as_array().ok_or("must be a list of KEY=VALUE")?;
            if arr.len() > 64 {
                return Err("too many creation options".into());
            }
            let drv_opt = o.driver_option.as_deref().unwrap_or("");
            let drv = match prior.get(drv_opt) {
                Some(OptVal::Text(d)) => d.clone(),
                _ => return Err("choose the driver first".into()),
            };
            let flag = o.flag.as_deref().unwrap_or("-co");
            let known = drivers.creation_options(&drv, flag).ok_or_else(|| format!("{drv}'s creation options are not known"))?;
            let mut items = Vec::new();
            for it in arr {
                let s = it.as_str().ok_or("each item must be KEY=VALUE text")?;
                let (k, val) = s.split_once('=').ok_or_else(|| format!("{s:?} is not KEY=VALUE"))?;
                let k = k.trim();
                if !plain_token(k, 64, &[]) {
                    return Err(format!("{k:?} is not an option name"));
                }
                if val.len() > 256 || val.chars().any(|c| c.is_control()) {
                    return Err(format!("the value of {k} is too long or has control characters"));
                }
                let spec = known.iter().find(|c| c.name.eq_ignore_ascii_case(k)).ok_or_else(|| format!("{drv} has no creation option {k}"))?;
                check_creation_value(spec, val).map_err(|e| format!("{k}: {e}"))?;
                items.push(format!("{}={}", spec.name, val));
            }
            Ok(OptVal::List(items))
        }
    }
}

/// A creation option value against the driver's declared type.
pub fn check_creation_value(spec: &gwb_sidecar_api::CreationOption, val: &str) -> Result<(), String> {
    let t = spec.kind.to_ascii_lowercase();
    match t.as_str() {
        "string-select" => {
            if spec.values.is_empty() || spec.values.iter().any(|v| v.eq_ignore_ascii_case(val)) {
                Ok(())
            } else {
                Err(format!("{val:?} is not one of {}", spec.values.join(", ")))
            }
        }
        "int" | "integer" | "unsigned int" => {
            let n: i64 = val.trim().parse().map_err(|_| format!("{val:?} is not a whole number"))?;
            if spec.min.is_some_and(|m| (n as f64) < m) || spec.max.is_some_and(|m| (n as f64) > m) {
                return Err(format!("{n} is out of range"));
            }
            Ok(())
        }
        "float" => {
            let f: f64 = val.trim().parse().map_err(|_| format!("{val:?} is not a number"))?;
            if !f.is_finite() || spec.min.is_some_and(|m| f < m) || spec.max.is_some_and(|m| f > m) {
                return Err(format!("{f} is out of range"));
            }
            Ok(())
        }
        "boolean" => match val.to_ascii_uppercase().as_str() {
            "YES" | "NO" | "TRUE" | "FALSE" | "ON" | "OFF" | "1" | "0" => Ok(()),
            _ => Err(format!("{val:?} is not YES or NO")),
        },
        // Free strings: no path separators or URL schemes, which some drivers would follow.
        _ => {
            let l = val.to_ascii_lowercase();
            if val.contains(['\\', '/']) || l.contains("://") || l.starts_with("/vsi") || val.starts_with('@') {
                Err("paths and URLs are not allowed in creation options".into())
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gwb_sidecar_api::CreationOption;
    use serde_json::json;

    struct Fake;
    impl DriverInfo for Fake {
        fn raster_writer(&self, n: &str) -> bool {
            ["GTiff", "COG", "HFA"].contains(&n)
        }
        fn vector_writer(&self, n: &str) -> bool {
            ["GPKG", "ESRI Shapefile"].contains(&n)
        }
        fn creation_options(&self, d: &str, _f: &str) -> Option<Vec<CreationOption>> {
            (d == "GTiff").then(|| {
                vec![
                    CreationOption { name: "COMPRESS".into(), kind: "string-select".into(), values: vec!["NONE".into(), "LZW".into(), "DEFLATE".into()], default: None, description: None, min: None, max: None },
                    CreationOption { name: "ZLEVEL".into(), kind: "int".into(), values: vec![], default: None, description: None, min: Some(1.0), max: Some(9.0) },
                    CreationOption { name: "PROFILE".into(), kind: "string".into(), values: vec![], default: None, description: None, min: None, max: None },
                ]
            })
        }
    }

    #[test]
    fn all_profiles_load() {
        let ps = load_all().unwrap();
        assert!(ps.len() >= 12);
        for id in ["raster-cog", "raster-jp2", "vector-gpkg", "vector-fgb", "vector-parquet", "probe", "export-gdal", "export-ogr", "points-copc", "video-h264-klv", "raster-vrt-cog"] {
            assert!(ps.iter().any(|p| p.id == id), "{id}");
        }
    }

    fn profile(id: &str) -> Profile {
        load_all().unwrap().into_iter().find(|p| p.id == id).unwrap()
    }

    /// REQ-GAP-29: the job's further outputs land beside the main one, and nothing asks for a GPU.
    #[test]
    fn sfm_block_stays_in_the_job_and_on_the_cpu() {
        let all = load_all().unwrap();
        let p = all.iter().find(|p| p.id == "sfm-block").expect("the profile");
        assert!(p.allow_dir_inputs, "the block is a folder");
        assert_eq!(p.module, "sfm");
        struct NoDrivers;
        impl DriverInfo for NoDrivers {
            fn raster_writer(&self, _: &str) -> bool {
                false
            }
            fn vector_writer(&self, _: &str) -> bool {
                false
            }
            fn creation_options(&self, _: &str, _: &str) -> Option<Vec<gwb_sidecar_api::CreationOption>> {
                None
            }
        }
        let opts = p.check_options(&BTreeMap::new(), &NoDrivers).unwrap();
        let c = ctx(&["/in/photos"]);
        let args: Vec<Vec<String>> = p.steps.iter().map(|s| p.expand(s, &c, &opts).unwrap()).collect();
        let flat: Vec<&String> = args.iter().flatten().collect();
        assert!(flat.iter().any(|a| *a == "/o/s.copc.laz"), "{flat:?}");
        assert!(flat.iter().any(|a| *a == "/o/s.dsm.tif"));
        assert!(flat.iter().any(|a| *a == "/o/s.frames.geojson"));
        assert!(flat.iter().all(|a| !a.contains('{')), "an unfilled placeholder: {flat:?}");
        // Every use_gpu switch is off, and COLMAP's own dense stage is never called.
        for w in args.iter().flat_map(|a| a.windows(2)) {
            if w[0].ends_with("use_gpu") {
                assert_eq!(w[1], "0");
            }
        }
        assert!(!flat.iter().any(|a| *a == "patch_match_stereo"));
        // A number out of range is refused by name.
        let mut bad = BTreeMap::new();
        bad.insert("views".to_string(), Value::from(99));
        assert!(p.check_options(&bad, &NoDrivers).unwrap_err().contains("views"));
    }

    fn ctx(inputs: &[&str]) -> ExpandCtx {
        ExpandCtx { inputs: inputs.iter().map(|s| s.to_string()).collect(), output: "/o/out".into(), workdir: "/w".into(), provenance: "p".into(), stem: "s".into(), list: String::new(), script_dir: "/m/sar/scripts".into(), modules_dir: "/m".into(), sds: String::new(), sds_args: vec![] }
    }

    #[test]
    fn the_first_input_is_the_pan_and_each_other_a_spectral_file() {
        let p = profile("raster-pansharpen");
        let o = p.check_options(&BTreeMap::from([("weights".into(), json!([0.25, 0.5, 0.25]))]), &Fake).unwrap();
        let a = p.expand(&p.steps[0], &ctx(&["pan.tif", "b1.tif", "b2.tif"]), &o).unwrap();
        let at = |k: &str| a.iter().position(|x| x == k).unwrap();
        assert_eq!(a[at("--panchromatic") + 1], "pan.tif");
        let sp: Vec<&String> = a.iter().enumerate().filter(|(i, x)| *i > 0 && a[i - 1] == "--spectral" && !x.is_empty()).map(|(_, x)| x).collect();
        assert_eq!(sp, ["b1.tif", "b2.tif"]);
        assert_eq!(a[at("--weights") + 1], "0.25,0.5,0.25");
        assert!(!a.contains(&"--nodata".to_string()));
    }

    #[test]
    fn float_lists_and_names_are_checked() {
        let p = profile("raster-pansharpen");
        for bad in [json!([]), json!("0.5"), json!(["0.5"]), json!([0.5, "x"]), json!([-1.0]), json!([1e9]), json!(vec![0.5; 65])] {
            assert!(p.check_options(&BTreeMap::from([("weights".into(), bad.clone())]), &Fake).is_err(), "{bad}");
        }
        let g = profile("pgraster-cog");
        let good = BTreeMap::from([("dbname".to_string(), json!("gis")), ("user".to_string(), json!("reader")), ("table".to_string(), json!("dem.v2"))]);
        assert!(g.check_options(&good, &Fake).is_ok());
        for bad in ["x host=evil", "a'b", "-x", "", "a;b", "a=b", &"n".repeat(64)] {
            let mut r = good.clone();
            r.insert("table".into(), json!(bad));
            assert!(g.check_options(&r, &Fake).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn compound_crs() {
        let p = profile("raster-reproject");
        let ok = p.check_options(&BTreeMap::from([("t_srs".into(), json!("EPSG:4269+5703"))]), &Fake).unwrap();
        assert_eq!(ok["t_srs"], OptVal::Text("EPSG:4269+5703".into()));
        for bad in ["EPSG:4269+", "EPSG:+5703", "EPSG:4269+5703+1", "EPSG:1+5703", "EPSG:4269 +5703", "WGS84", "EPSG:4326;x"] {
            assert!(p.check_options(&BTreeMap::from([("t_srs".into(), json!(bad))]), &Fake).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_best_is_the_default_for_grids() {
        let p = profile("raster-reproject");
        let o = p.check_options(&BTreeMap::from([("t_srs".into(), json!("EPSG:4269"))]), &Fake).unwrap();
        let a = p.expand(&p.steps[0], &ctx(&["in.tif"]), &o).unwrap();
        assert!(a.contains(&"ONLY_BEST=YES".to_string()) && a.contains(&"ALLOW_BALLPARK=NO".to_string()));
        let o = p.check_options(&BTreeMap::from([("t_srs".into(), json!("EPSG:4269")), ("only_best".into(), json!(false))]), &Fake).unwrap();
        assert!(!p.expand(&p.steps[0], &ctx(&["in.tif"]), &o).unwrap().contains(&"ONLY_BEST=YES".to_string()));
    }

    #[test]
    fn the_database_profile_is_gated_and_nothing_else_is() {
        let ps = load_all().unwrap();
        let gated: Vec<&str> = ps.iter().filter(|p| p.gate.is_some()).map(|p| p.id.as_str()).collect();
        assert_eq!(gated, ["pgraster-cog"]);
        let p = profile("pgraster-cog");
        assert_eq!((p.min_inputs, p.max_inputs), (0, 0));
        let conn = p.steps[0].args.iter().find_map(|a| if let Arg::Text(t) = a { t.starts_with("PG:").then_some(t) } else { None }).unwrap();
        assert!(conn.contains("host=127.0.0.1 "), "{conn}");
    }

    #[test]
    fn the_ossim_profile_passes_only_checked_numbers() {
        let p = profile("ossim-rpc");
        assert_eq!(p.module, "ossim");
        assert!(p.allow_pointer_inputs, "a product.xml names its image");
        assert!(p.gate.is_none());
        let o = p.check_options(&BTreeMap::from([("h_min".into(), json!(100)), ("h_max".into(), json!(2500.5))]), &Fake).unwrap();
        let a = p.expand(&p.steps[0], &ctx(&["product.xml"]), &o).unwrap();
        assert_eq!(a[..5], ["grid", "--h-min", "100", "--h-max", "2500.5"]);
        assert_eq!(a[5..], ["product.xml", "/o/out"]);
        for bad in [json!("1; x"), json!(-501), json!(9001)] {
            assert!(p.check_options(&BTreeMap::from([("h_min".into(), bad.clone())]), &Fake).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_new_gate_or_module_name_is_a_build_error() {
        let bad = r#"id = "x"
title = "x"
module = "core-gdal"
input = "any"
gate = "network"
[[steps]]
tool = "gdalinfo"
args = ["{input}"]
"#;
        let p: Profile = toml::from_str(bad).unwrap();
        assert!(validate_profile(&p).unwrap_err().contains("unknown gate"));
    }

    /// REQ-GAP-51: the H.264 profile exists only where the OpenH264 module can, keeps the KLV as
    /// the other video profiles do, and reads no option into a place a value could widen.
    #[cfg(not(windows))]
    #[test]
    fn openh264_profile() {
        let ps = load_all().unwrap();
        let p = ps.iter().find(|p| p.id == "video-h264-openh264").unwrap();
        assert_eq!(p.module, crate::modules::OPENH264);
        assert_eq!(p.steps[0].tool, "ffmpeg-h264");
        assert_eq!(crate::modules::module_of_tool("ffmpeg-h264").unwrap().id, crate::modules::OPENH264);
        assert_eq!(crate::modules::def(crate::modules::OPENH264).unwrap().title, "OpenH264 Video Codec provided by Cisco Systems, Inc.");
        let o = p.check_options(&BTreeMap::new(), &Fake).unwrap();
        let ctx = ExpandCtx { inputs: vec!["/d/in.ts".into()], output: "/d/out.ts".into(), workdir: "/d".into(), provenance: "p".into(), stem: "in".into(), list: String::new(), script_dir: String::new(), modules_dir: String::new(), sds: String::new(), sds_args: vec![] };
        let a = p.expand(&p.steps[0], &ctx, &o).unwrap();
        for w in ["libopenh264", "-copyts", "-mpegts_copyts", "file,pipe"] {
            assert!(a.iter().any(|x| x == w), "{w}");
        }
        assert!(p.check_options(&BTreeMap::from([("encoder".to_string(), json!("libx264"))]), &Fake).is_err(), "the encoder is not an option");
    }

    fn cog() -> Profile {
        load_all().unwrap().into_iter().find(|p| p.id == "raster-cog").unwrap()
    }

    #[test]
    fn options_are_checked() {
        let p = cog();
        let ok = p.check_options(&BTreeMap::from([("compress".into(), json!("ZSTD"))]), &Fake).unwrap();
        assert_eq!(ok["compress"], OptVal::Text("ZSTD".into()));
        for (k, v) in [("compress", json!("ZSTD; calc.exe")), ("compress", json!(5)), ("quality", json!(1000)), ("quality", json!(-1)), ("quality", json!("90 -co X=Y")), ("nodata", json!("nan")), ("nodata", json!(f64::MAX)), ("shell", json!("x"))] {
            assert!(p.check_options(&BTreeMap::from([(k.to_string(), v.clone())]), &Fake).is_err(), "{k}={v}");
        }
    }

    #[test]
    fn expansion_keeps_values_in_one_argument() {
        let p = cog();
        let opts = p.check_options(&BTreeMap::from([("compress".into(), json!("JPEG")), ("quality".into(), json!(80))]), &Fake).unwrap();
        let ctx = ExpandCtx { inputs: vec![r"C:\d\in put.sid".into()], output: r"C:\d\out.tif".into(), workdir: r"C:\d".into(), provenance: "p q".into(), stem: "in put".into(), list: String::new(), script_dir: String::new(), modules_dir: String::new(), sds: String::new(), sds_args: vec![] };
        let args = p.expand(&p.steps[0], &ctx, &opts).unwrap();
        assert!(args.contains(&r"C:\d\in put.sid".to_string()));
        assert!(args.contains(&"COMPRESS=JPEG".to_string()));
        assert!(args.contains(&"QUALITY=80".to_string()));
        assert_eq!(args.last().unwrap(), r"C:\d\out.tif");
    }

    #[test]
    fn creation_options_follow_the_driver() {
        let p = load_all().unwrap().into_iter().find(|p| p.id == "export-gdal").unwrap();
        let good = p.check_options(&BTreeMap::from([("driver".into(), json!("GTiff")), ("co".into(), json!(["COMPRESS=LZW", "zlevel=6"]))]), &Fake).unwrap();
        assert_eq!(good["co"], OptVal::List(vec!["COMPRESS=LZW".into(), "ZLEVEL=6".into()]));
        for bad in [json!(["COMPRESS=BROTLI"]), json!(["ZLEVEL=12"]), json!(["NOPE=1"]), json!(["PROFILE=/vsicurl/http://x"]), json!(["PROFILE=..\\..\\x"]), json!(["COMPRESS"]), json!(["-of=X"]), json!("COMPRESS=LZW")] {
            assert!(p.check_options(&BTreeMap::from([("driver".into(), json!("GTiff")), ("co".into(), bad.clone())]), &Fake).is_err(), "{bad}");
        }
        assert!(p.check_options(&BTreeMap::from([("driver".into(), json!("MrSID"))]), &Fake).is_err());
        assert!(p.check_options(&BTreeMap::from([("driver".into(), json!("GTiff -of VRT"))]), &Fake).is_err());
    }
}
