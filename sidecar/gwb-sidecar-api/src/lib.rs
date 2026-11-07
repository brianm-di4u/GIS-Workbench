//! Wire types of the GIS Workbench sidecar API (Appendix D §8.2, SDP-2.1 §3.3–§3.5).
//!
//! Every request body is parsed with `deny_unknown_fields` and range-checked by the service; the
//! JSON Schema exported from these types (`export-schema`) is what the JS client's contract tests
//! validate requests and responses against (SDP-2.1 §7.3).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// API level. The app warns when the sidecar's level is lower than the one it needs (REQ-SDC-13).
pub const API_LEVEL: u32 = 1;
/// The three loopback ports, tried in order (REQ-SDC-02).
pub const PORTS: [u16; 3] = [47821, 47822, 47823];
/// Largest JSON request body accepted.
pub const MAX_JSON_BODY: usize = 64 * 1024;
/// Most inputs a single job may take (a multi-file MrSID delivery for the VRT mosaic profile).
pub const MAX_JOB_INPUTS: usize = 4096;
/// Largest MCP message a relay client may send (REQ-GAP-02).
pub const MAX_RELAY_MESSAGE: usize = 1 << 20;
/// Largest reply the page may hand back through the relay (`tools/list` is the big one).
pub const MAX_RELAY_REPLY: usize = 8 << 20;
/// Largest view-and-cursor message (REQ-GAP-65).
pub const MAX_SYNC_MESSAGE: usize = 1024;

/// `GET /v1/hello`: answered to every allow-listed origin, with or without a token.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    /// Always `"gwb-sidecar"`.
    pub service: String,
    pub version: String,
    pub api: u32,
    pub port: u16,
    /// Whether the request carried a valid token for its origin.
    pub paired: bool,
    /// The origin as the sidecar saw it (`"null"` for file://).
    pub origin: String,
    /// `"preview"` while builds are unsigned.
    pub channel: String,
}

/// `POST /v1/pair`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PairRequest {
    /// The client's own name as shown in the sidecar window (1–80 printable characters).
    pub client: String,
}

/// Answer to `POST /v1/pair`: the app shows `code`; the sidecar window shows the same code.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PairStart {
    /// Unguessable id of this pairing request; only its holder can collect the token.
    pub pairing_id: String,
    /// Six digits.
    pub code: String,
    /// Seconds until the request lapses.
    pub expires_in: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PairState {
    Pending,
    Approved,
    Denied,
    Expired,
}

/// `GET /v1/pair/{pairing_id}`: the token is handed out once, on the first poll after approval.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PairStatus {
    pub state: PairState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// Error body of every non-2xx answer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ErrorBody {
    /// Stable machine code, e.g. `bad_host`, `origin_not_allowed`, `unauthorized`, `bad_request`.
    pub code: String,
    /// One plain sentence for the user.
    pub error: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum DataKind {
    Raster,
    Vector,
    Points,
    Video,
    /// A 3D model (glTF, OBJ, STL, PLY, COLLADA…).
    Model,
    Any,
}

/// A GDAL raster or OGR vector driver as the sidecar's GDAL reports it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Driver {
    pub name: String,
    pub long_name: String,
    pub raster: bool,
    pub vector: bool,
    pub read: bool,
    /// Creates new files (`+` or `w` in GDAL's flags); never true for MrSID/ECW (OD-2.7).
    pub write: bool,
    pub extensions: Vec<String>,
}

/// One creation option of a driver (from its `DMD_CREATIONOPTIONLIST`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CreationOption {
    pub name: String,
    /// `string-select`, `int`, `float`, `boolean`, `string`…
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

/// `GET /v1/caps/drivers/{name}`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DriverDetail {
    pub driver: Driver,
    pub creation_options: Vec<CreationOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolInfo {
    pub name: String,
    pub module: String,
    pub version: String,
}

/// An optional module (REQ-SDC-11): Core GDAL, Media, Point cloud, Python runtime, vendor plugins.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModuleInfo {
    pub id: String,
    pub title: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// SPDX-style licence summary of the module's components.
    pub licence: String,
    /// Installed size in bytes (0 if not installed).
    pub size: u64,
}

/// A closed vendor decode SDK and whether its licence was accepted (REQ-SDC-05, REQ-SDC-12).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VendorSdk {
    pub id: String,
    pub name: String,
    /// GDAL drivers it provides.
    pub drivers: Vec<String>,
    pub installed: bool,
    pub licence_accepted: bool,
    /// Where it comes from (e.g. the OSGeo4W package name).
    pub source: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OptionKind {
    Enum,
    Int,
    Float,
    Bool,
    /// A writable GDAL raster driver name from the caps.
    RasterDriver,
    /// A writable OGR vector driver name from the caps.
    VectorDriver,
    /// `KEY=VALUE` items checked against the chosen driver's creation option list.
    CreationOptions,
    /// An EPSG code (`EPSG:n`, 1024 ≤ n ≤ 999999), or a compound `EPSG:h+v` of two such codes.
    Crs,
    /// A list of finite numbers, each within min and max.
    FloatList,
    /// A database or table name: 1–63 ASCII letters, digits, `_`, `-` or `.`.
    Name,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OptionSpec {
    pub name: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: OptionKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub optional: bool,
}

/// A fixed job profile as offered to the app (REQ-SDC-08).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProfileInfo {
    pub id: String,
    pub title: String,
    pub module: String,
    pub input: DataKind,
    pub min_inputs: u32,
    pub max_inputs: u32,
    /// Output extension (empty for `probe`, whose result is JSON).
    pub output_ext: String,
    pub options: Vec<OptionSpec>,
    /// False when a module it needs is not installed.
    pub available: bool,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_json_body: u64,
    pub max_upload: u64,
    pub max_job_inputs: u32,
    pub concurrent_jobs: u32,
    pub quota_bytes: u64,
    pub free_bytes: u64,
}

/// `GET /v1/caps` (REQ-SDC-05).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Caps {
    pub service: String,
    pub version: String,
    pub api: u32,
    pub modules: Vec<ModuleInfo>,
    pub tools: Vec<ToolInfo>,
    pub raster_drivers: Vec<Driver>,
    pub vector_drivers: Vec<Driver>,
    pub pdal_readers: Vec<String>,
    pub pdal_writers: Vec<String>,
    pub ffmpeg_encoders: Vec<String>,
    pub ffmpeg_decoders: Vec<String>,
    pub vendor: Vec<VendorSdk>,
    pub profiles: Vec<ProfileInfo>,
    pub limits: Limits,
    pub features: Features,
    /// The CSM plug-in host (REQ-GAP-25): off in every shipped build (OD-2.18).
    pub csm_host: CsmHostCaps,
}

/// What this sidecar offers beyond jobs. The app shows a command from these, never from a list of
/// its own (REQ-SDC-05).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Features {
    /// The native stereo viewer is installed and this platform has its window (REQ-GAP-33).
    pub stereo_viewer: bool,
    /// View and cursor sync with an ArcGIS Pro add-in (REQ-GAP-65).
    pub pro_sync: bool,
    /// The outbound CORS relay (REQ-GAP-08). False in every shipped build (OD-2.17).
    pub cors_relay: bool,
}

/// `POST /v1/jobs`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct JobRequest {
    pub profile: String,
    /// File ids from `PUT /v1/files`, `POST /v1/pick` or earlier outputs.
    pub inputs: Vec<String>,
    #[serde(default)]
    pub options: BTreeMap<String, serde_json::Value>,
    /// Name for the output (sanitised; the profile's extension is enforced).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_name: Option<String>,
    /// Free text shown in the sidecar's job list (≤ 200 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `POST /v1/batch`: one job per matching file of a picked folder.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
    pub profile: String,
    /// A folder id from `POST /v1/pick` with `mode: "folder"`.
    pub folder: String,
    /// Extensions to take (lower case, no dot), e.g. `["sid"]`.
    pub extensions: Vec<String>,
    #[serde(default)]
    pub options: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BatchResult {
    pub jobs: Vec<Job>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn finished(self) -> bool {
        matches!(self, JobState::Succeeded | JobState::Failed | JobState::Cancelled)
    }
}

/// Tool, version and arguments of every step, also written beside the output (REQ-SDC-08).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StepRecord {
    pub tool: String,
    pub version: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub sidecar: String,
    pub profile: String,
    pub options: BTreeMap<String, serde_json::Value>,
    pub inputs: Vec<String>,
    pub steps: Vec<StepRecord>,
    pub started: String,
    pub finished: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileOrigin {
    Upload,
    Pick,
    Output,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub origin: FileOrigin,
    /// For a picked folder: the files in it (names only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<String>,
    /// Upload group: pass it as `group=` to upload companion files (.sdw, .aux.xml, .shx…) beside this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Job {
    pub id: String,
    pub profile: String,
    pub state: JobState,
    /// 0..1, or null while unknown.
    #[serde(default)]
    pub progress: Option<f64>,
    pub inputs: Vec<String>,
    pub outputs: Vec<FileInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Structured result (the `probe` profile's match and tool reports).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Id of the job this one retried.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
}

/// One line of `GET /v1/jobs/{id}/events` (application/x-ndjson).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum JobEvent {
    State { state: JobState },
    Progress { progress: f64 },
    Log { line: String },
    Done { job: Job },
}

/// `POST /v1/pick`: the sidecar opens its own native picker (zero copy for large inputs).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PickRequest {
    pub mode: PickMode,
    /// Shown in the picker's title (≤ 100 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PickMode {
    File,
    Files,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PickResult {
    /// Empty when the user cancelled.
    pub files: Vec<FileInfo>,
}

/// `POST /v1/files/{id}/save`: copies an output to a folder the user picks in the sidecar.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SaveResult {
    pub saved: bool,
    /// The folder's display name only (no full path leaves the sidecar).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// `POST /v1/views`: open a file the app cannot decode as a view read by range (REQ-GAP-70).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewRequest {
    /// A file id from `/v1/files` or `/v1/pick`.
    pub file: String,
}

/// A view: a BigTIFF of `size` bytes at `GET /v1/views/{id}`, read by range; tiles are decoded as
/// they are read. Writing is not offered, and a view never leaves this computer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewInfo {
    pub id: String,
    /// The source file's name.
    pub name: String,
    /// The GDAL driver that reads it: `MrSID` or `ECW`.
    pub driver: String,
    /// Bytes of the virtual file (nothing of this size exists on disk).
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub bands: u32,
    /// GDAL data type of every band.
    pub sample_type: String,
    /// Full resolution plus overviews.
    pub levels: u32,
    /// Tile side in pixels.
    pub tile: u32,
}

/// The list endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct JobList {
    pub jobs: Vec<Job>,
}

/// `GET /relay/v1/hello` (REQ-GAP-02): what a relay client (never a browser page) may ask first.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayHello {
    /// Always `"gwb-sidecar"`.
    pub service: String,
    pub version: String,
    pub api: u32,
    pub port: u16,
    /// Whether the request carried a valid relay token.
    pub paired: bool,
    /// Whether a page has the relay on; always false without a valid token.
    pub app: bool,
}

/// `POST /v1/relay/attach`: the page turns the relay on.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayAttach {
    /// The page's own name as shown in the sidecar window (1–80 printable characters).
    pub client: String,
}

/// Answer to `POST /v1/relay/attach`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayAttached {
    /// Unguessable id of this attachment.
    pub session: String,
    /// Longest the sidecar holds one `inbox` request, in seconds.
    pub hold_s: u32,
}

/// `GET /v1/relay/{session}/inbox`: one MCP message for the page to answer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayDelivery {
    /// Id of this delivery, quoted in the reply.
    pub rid: String,
    /// The paired client's name, as approved in the sidecar window.
    pub client: String,
    /// The JSON-RPC 2.0 request, already checked by the sidecar.
    pub message: serde_json::Value,
}

/// `POST /v1/relay/{session}/reply`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayReply {
    pub rid: String,
    /// The JSON-RPC 2.0 response from the page's MCP server.
    pub reply: serde_json::Value,
}

/// A map position in WGS 84 and how much ground one screen pixel covers: what the app and ArcGIS Pro
/// have in common (REQ-GAP-65). Each side projects to and from its own coordinate system.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncView {
    /// Degrees east, −180 to 180.
    pub lon: f64,
    /// Degrees north, −90 to 90.
    pub lat: f64,
    /// Metres on the ground per screen pixel at the centre of the view.
    pub mpp: f64,
    /// Degrees, clockwise from north up, −360 to 360.
    pub rotation: f64,
}

/// The cursor on a side's map; `visible: false` when it left the map (the position is then ignored).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncCursor {
    pub lon: f64,
    pub lat: f64,
    pub visible: bool,
}

/// `POST /sync/v1/state` and `POST /v1/sync/{session}/state`: at least one of the two.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncPublish {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<SyncView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<SyncCursor>,
}

/// `GET .../next?after=<seq>`: what the other side published since `after`, newest only: a state
/// stream, not a queue, so a slow reader skips to the present.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncUpdate {
    /// Quote this as the next `after`.
    pub seq: u64,
    /// Whether the other side is there now.
    pub peer: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<SyncView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<SyncCursor>,
}

/// Who follows whom, chosen in the app. The sidecar refuses a publish from the side that follows.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
    Both,
    AppFollows,
    ProFollows,
}

/// `POST /v1/sync/attach`: the page turns sync on.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncAttach {
    /// The page's own name as shown in the sidecar window (1–80 printable characters).
    pub client: String,
    pub direction: SyncDirection,
}

/// Answer to `POST /v1/sync/attach`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncAttached {
    /// Unguessable id of this attachment.
    pub session: String,
    /// Longest the sidecar holds one `next` request, in seconds.
    pub hold_s: u32,
}

/// `GET /sync/v1/hello`: what the add-in may ask first.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncHello {
    /// Always `"gwb-sidecar"`.
    pub service: String,
    pub version: String,
    pub api: u32,
    pub port: u16,
    /// Whether the request carried a valid add-in token.
    pub paired: bool,
    /// Whether a page has sync on; always false without a valid token.
    pub app: bool,
    /// Who follows whom now; absent while no page has sync on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<SyncDirection>,
}

/// How the viewer shows a pair.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum StereoMode {
    /// Quad-buffer on a display that has it, else anaglyph.
    #[default]
    Auto,
    /// Quad-buffer (active shutter); falls back to anaglyph, by name, where there is none.
    Quad,
    Anaglyph,
    SideBySide,
}

/// `POST /v1/stereo`: show a pair in the native viewer (REQ-GAP-33).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StereoRequest {
    /// File id of the left eye's image.
    pub left: String,
    /// File id of the right eye's image.
    pub right: String,
    #[serde(default)]
    pub mode: StereoMode,
    /// Display plane to left image pixels, `[a, b, c, d, e, f]`: `x = a·u + b·v + c`,
    /// `y = d·u + e·v + f`. This is how the app's epipolar fit reaches the viewer. Default: identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_affine: Option<[f64; 6]>,
    /// The same for the right image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_affine: Option<[f64; 6]>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StereoState {
    /// The viewer is starting or loading its first tiles.
    Starting,
    /// A full frame is on the display.
    Showing,
    /// The window was closed or the session deleted.
    Closed,
    /// The viewer stopped by itself; `detail` says why.
    Failed,
}

/// What the buffers held after a frame: the software proof a display cannot give. Sent by test
/// devices only.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StereoReadback {
    /// SHA-256 of the left eye's buffer as drawn.
    pub left_sha256: String,
    /// SHA-256 of the right eye's buffer as drawn.
    pub right_sha256: String,
    /// Mean of the left buffer's red, green and blue, 0–255.
    pub left_mean: [f64; 3],
    pub right_mean: [f64; 3],
    /// Horizontal shift of the right eye against the left, in screen pixels, by cross-correlation.
    pub disparity_px: f64,
    pub disparity_score: f64,
    /// What `GL_STEREO` says about the context.
    pub gl_stereo: bool,
    /// `GL_RENDERER`.
    pub renderer: String,
    /// The GL calls of the last frame that chose a colour buffer, in order.
    pub draw_buffers: Vec<String>,
}

/// `POST /stereo/v1/{id}/report`: the viewer tells the sidecar what it is doing.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StereoReport {
    pub state: StereoState,
    /// The mode on the display.
    pub shown: StereoMode,
    /// Whether this display offers a quad-buffer pixel format.
    pub quad_available: bool,
    pub frames: u64,
    /// Why the mode is not the one asked for, or why the viewer failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readback: Option<StereoReadback>,
}

/// `GET /v1/stereo/{id}`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StereoInfo {
    pub id: String,
    pub state: StereoState,
    pub requested: StereoMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown: Option<StereoMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quad_available: Option<bool>,
    pub frames: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub left: ViewInfo,
    pub right: ViewInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readback: Option<StereoReadback>,
}

/// One eye as the viewer needs it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StereoEye {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Size of each level, finest first; each is half the one before.
    pub levels: Vec<[u32; 2]>,
    pub affine: [f64; 6],
}

/// `GET /stereo/v1/{id}/scene`: everything but the pixels. A tile is `tile`² RGBA8 pixels.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StereoScene {
    pub tile: u32,
    pub mode: StereoMode,
    pub left: StereoEye,
    pub right: StereoEye,
}

/// `POST /v1/cors-relay/fetch` (REQ-GAP-08). Only in builds with the relay compiled in, and only
/// with its gate open; a shipped build has neither (OD-2.17). There is no field for a body, a
/// cookie or an Authorization header.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CorsRelayRequest {
    /// An https URL of an origin the user listed in the sidecar window.
    pub url: String,
    /// GET or HEAD.
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept: Option<String>,
    /// `bytes=a-b` or `bytes=a-`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
}

/// Whether the CSM plug-in host can be used, and if not, why.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmHostCaps {
    pub available: bool,
    pub note: String,
}

/// `POST /v1/csm/plugins`: record a plug-in file for the user to approve. Nothing of it runs yet.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmPluginAdd {
    /// A file id from `PUT /v1/files` or `POST /v1/pick`.
    pub file: String,
}

/// What the operating system says about a plug-in file's signature.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmSigner {
    /// `valid`, `untrusted` (signed, but by no trusted root), `unsigned`, `invalid`, or
    /// `unchecked` where the platform has no check (Linux).
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// SHA-1 of the signing certificate, as Windows shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbprint: Option<String>,
}

/// One recorded plug-in. The hash and signer are what the user approves.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmPluginRecord {
    pub sha256: String,
    pub name: String,
    pub size: u64,
    pub signer: CsmSigner,
    /// `pending`, `approved` or `refused`.
    pub state: String,
    pub added: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided: Option<String>,
}

/// `POST /v1/csm/sessions`: start a sandboxed host for an approved plug-in.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmSessionOpen {
    /// The approved plug-in's SHA-256.
    pub plugin: String,
    /// The image support data, a file id.
    pub isd: String,
    /// A model of the plug-in; the first that accepts the ISD when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Answer to `POST /v1/csm/sessions`. Everything but `id` and `confinement` is the plug-in's word.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmSessionInfo {
    pub id: String,
    pub protocol: u32,
    pub confinement: String,
    pub plugin_name: String,
    pub manufacturer: String,
    pub release_date: String,
    pub csm_version: String,
    pub model: String,
    pub model_version: String,
    pub sensor: String,
    pub platform: String,
    pub collection: String,
    pub trajectory: String,
    pub sensor_type: String,
    pub sensor_mode: String,
}

/// `POST /v1/csm/sessions/{id}/g2i` (x, y, z in ECEF metres) and `/i2g` (line, sample, height
/// above the model's ellipsoid in metres).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmPoints {
    pub points: Vec<[f64; 3]>,
    /// Desired precision: pixels for ground to image, metres for image to ground.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<f64>,
}

/// `g2i`: line, sample, achieved precision. `i2g`: x, y, z, achieved precision.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmPointsReply {
    pub points: Vec<Vec<f64>>,
}

/// `POST /v1/csm/sessions/{id}/partials`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmPartialsRequest {
    pub ground: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmPartials {
    /// d line / d x, y, z, then d sample / d x, y, z.
    pub ground: [f64; 6],
    /// d line and d sample by each model parameter.
    pub sensor: Vec<[f64; 2]>,
}

/// `POST /v1/csm/sessions/{id}/covariance`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmCovarianceRequest {
    /// Line and sample.
    pub image: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CsmCovariance {
    /// Unmodelled error at the point, pixels squared: line, line by sample, sample.
    pub unmodeled: [f64; 3],
    pub parameters: u32,
    /// The parameter covariance, by rows.
    pub covariance: Vec<f64>,
}

/// Every type, by name, for the schema export.
pub fn schema_document() -> serde_json::Value {
    let mut defs = serde_json::Map::new();
    macro_rules! add {
        ($($t:ty),*) => {$(
            let s = schemars::schema_for!($t);
            defs.insert(stringify!($t).to_string(), serde_json::to_value(&s).expect("schema"));
        )*};
    }
    add!(Hello, PairRequest, PairStart, PairStatus, ErrorBody, Caps, DriverDetail, JobRequest, BatchRequest, BatchResult, Job, JobList, JobEvent, PickRequest, PickResult, FileInfo, SaveResult, RelayHello, RelayAttach, RelayAttached, RelayDelivery, RelayReply, ViewRequest, ViewInfo, Features, SyncPublish, SyncUpdate, SyncAttach, SyncAttached, SyncHello, StereoRequest, StereoInfo, StereoReport, StereoScene, CorsRelayRequest, CsmHostCaps, CsmPluginAdd, CsmPluginRecord, CsmSessionOpen, CsmSessionInfo, CsmPoints, CsmPointsReply, CsmPartialsRequest, CsmPartials, CsmCovarianceRequest, CsmCovariance);
    serde_json::json!({
        "title": "GIS Workbench sidecar API",
        "api": API_LEVEL,
        "ports": PORTS,
        "types": defs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_request_rejects_unknown_fields() {
        let bad = r#"{"profile":"raster-cog","inputs":["a"],"shell":"cmd /c calc"}"#;
        assert!(serde_json::from_str::<JobRequest>(bad).is_err());
        let ok = r#"{"profile":"raster-cog","inputs":["a"],"options":{"compress":"DEFLATE"}}"#;
        assert_eq!(serde_json::from_str::<JobRequest>(ok).unwrap().inputs, vec!["a"]);
    }

    #[test]
    fn events_are_tagged() {
        let e = JobEvent::Progress { progress: 0.5 };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"progress","progress":0.5}"#);
    }

    #[test]
    fn schema_has_every_type() {
        let d = schema_document();
        for t in ["Hello", "Caps", "Job", "JobEvent", "JobRequest"] {
            assert!(d["types"][t].is_object(), "{t}");
        }
    }
}
