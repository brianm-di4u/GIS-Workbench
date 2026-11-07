//! Running one tool: argument array (never a shell), the module's fixed environment, a working
//! folder, a Job Object with limits, a wall-clock limit, cancellation that kills the process tree,
//! and streamed stdout/stderr with progress parsing.

use crate::modules;
use crate::winjob::{spawn_in_job, JobLimits};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub struct RunSpec<'a> {
    pub modules_dir: &'a Path,
    pub tool: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub tmp: &'a Path,
    pub limits: JobLimits,
    pub wall: Duration,
    /// Keep stdout (up to this many bytes) for the caller.
    pub capture_stdout: usize,
    pub progress: Progress,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Progress {
    None,
    Gdal,
    Ffmpeg,
    Lines,
}

impl Progress {
    pub fn parse(s: &str) -> Progress {
        match s {
            "gdal" => Progress::Gdal,
            "ffmpeg" => Progress::Ffmpeg,
            "lines" => Progress::Lines,
            _ => Progress::None,
        }
    }
}

#[derive(Debug)]
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr_tail: Vec<String>,
    pub cancelled: bool,
    pub timed_out: bool,
    pub ms: u64,
    pub peak_memory: u64,
    pub killed_reason: Option<String>,
}

/// Callbacks: a log line, or progress 0..1 within this step.
pub trait Sink: Send + Sync {
    fn log(&self, line: &str);
    fn progress(&self, p: f64);
    /// Called every 500 ms while running; returning Some(reason) kills the job (quota, disk full).
    fn watchdog(&self) -> Option<String> {
        None
    }
}

pub async fn run(spec: RunSpec<'_>, cancel: CancellationToken, sink: Arc<dyn Sink>) -> Result<RunOutcome, String> {
    let te = modules::tool_env(spec.modules_dir, spec.tool, spec.tmp)?;
    std::fs::create_dir_all(spec.tmp).map_err(|e| format!("cannot create the job folder: {e}"))?;
    let mut cmd = Command::new(&te.program);
    cmd.args(spec.args).current_dir(spec.cwd).env_clear().envs(&te.env);
    let started = Instant::now();
    let (mut child, job) = spawn_in_job(cmd, spec.limits).map_err(|e| format!("{} could not start: {e}", spec.tool))?;
    let job = Arc::new(job);
    let mut out = child.stdout.take().expect("stdout");
    let mut err = child.stderr.take().expect("stderr");
    let dur = Arc::new(std::sync::Mutex::new(None::<f64>));
    let (dur_o, dur_e) = (dur.clone(), dur.clone());
    let sink2 = sink.clone();
    let cap = spec.capture_stdout;
    let prog = spec.progress;
    let out_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        let mut kept = Vec::new();
        let mut parser = ProgressParser::new(prog);
        loop {
            match out.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if kept.len() < cap {
                        kept.extend_from_slice(&chunk[..chunk.len().min(cap - kept.len())]);
                    }
                    if parser.duration_s.is_none() {
                        parser.duration_s = *dur_o.lock().unwrap();
                    }
                    for p in parser.feed_stdout(chunk) {
                        sink2.progress(p);
                    }
                    if cap == 0 && prog != Progress::Gdal && prog != Progress::Ffmpeg {
                        for l in String::from_utf8_lossy(chunk).lines() {
                            if !l.trim().is_empty() && !l.starts_with("PROGRESS ") {
                                sink2.log(l);
                            }
                        }
                    }
                }
            }
        }
        (kept, parser)
    });
    let sink3 = sink.clone();
    let err_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 8 * 1024];
        let mut pending = String::new();
        let mut tail: Vec<String> = Vec::new();
        let mut duration: Option<f64> = None;
        loop {
            match err.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(i) = pending.find(['\n', '\r']) {
                        let line: String = pending.drain(..=i).collect();
                        let line = line.trim_end();
                        // GDAL_SKIP names network drivers this build may not have; that is not news.
                        // PDF: libgdal was built for poppler's PDF plug-in, and says so of ours, which is PDFium's.
                        if line.is_empty() || line.contains("to unload from GDAL_SKIP") || line.contains("Proxy driver PDF declares") {
                            continue;
                        }
                        if duration.is_none() {
                            duration = ffmpeg_duration(line);
                            if duration.is_some() {
                                *dur_e.lock().unwrap() = duration;
                            }
                        }
                        sink3.log(line);
                        tail.push(line.chars().take(500).collect());
                        if tail.len() > 40 {
                            tail.remove(0);
                        }
                    }
                }
            }
        }
        if !pending.trim().is_empty() {
            sink3.log(pending.trim());
            tail.push(pending.trim().chars().take(500).collect());
        }
        (tail, duration)
    });
    let deadline = tokio::time::sleep(spec.wall);
    tokio::pin!(deadline);
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let mut cancelled = false;
    let mut timed_out = false;
    let mut killed_reason = None;
    let status = loop {
        tokio::select! {
            s = child.wait() => break s.ok(),
            _ = cancel.cancelled() => {
                cancelled = true;
                job.terminate(1);
                break child.wait().await.ok();
            }
            _ = &mut deadline => {
                timed_out = true;
                job.terminate(1);
                break child.wait().await.ok();
            }
            _ = tick.tick() => {
                if let Some(r) = sink.watchdog() {
                    killed_reason = Some(r);
                    job.terminate(1);
                    break child.wait().await.ok();
                }
            }
        }
    };
    // Grandchildren still running (a tool that spawned helpers) die with the job.
    job.terminate(1);
    let (stdout, parser) = out_task.await.unwrap_or_default();
    let (stderr_tail, duration) = err_task.await.unwrap_or_default();
    let _ = (parser, duration);
    Ok(RunOutcome {
        exit_code: status.and_then(|s| s.code()),
        stdout,
        stderr_tail,
        cancelled,
        timed_out,
        ms: started.elapsed().as_millis() as u64,
        peak_memory: job.peak_memory(),
        killed_reason,
    })
}

/// `Duration: 00:01:02.33,` in ffmpeg's stderr banner → seconds.
pub fn ffmpeg_duration(line: &str) -> Option<f64> {
    let i = line.find("Duration: ")?;
    let t = line[i + 10..].split(',').next()?.trim();
    hms(t)
}

fn hms(t: &str) -> Option<f64> {
    let mut parts = t.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Turns tool output into progress values.
pub struct ProgressParser {
    kind: Progress,
    text: String,
    pub duration_s: Option<f64>,
    last: f64,
}

impl Default for ProgressParser {
    fn default() -> Self {
        ProgressParser::new(Progress::None)
    }
}

impl ProgressParser {
    pub fn new(kind: Progress) -> Self {
        ProgressParser { kind, text: String::new(), duration_s: None, last: -1.0 }
    }

    pub fn feed_stdout(&mut self, chunk: &[u8]) -> Vec<f64> {
        let mut out = Vec::new();
        match self.kind {
            Progress::None => {}
            Progress::Gdal => {
                // "0...10...20...30...40...50...60...70...80...90...100 - done."
                self.text.push_str(&String::from_utf8_lossy(chunk));
                let mut best = None;
                let t = std::mem::take(&mut self.text);
                let mut keep_from = 0;
                let b = t.as_bytes();
                let mut i = 0;
                while i < b.len() {
                    if b[i].is_ascii_digit() {
                        let s = i;
                        while i < b.len() && b[i].is_ascii_digit() {
                            i += 1;
                        }
                        if i == b.len() {
                            keep_from = s; // the number may continue in the next chunk
                            break;
                        }
                        if t[i..].starts_with('.') || t[i..].starts_with(" - done") {
                            if let Ok(v) = t[s..i].parse::<u32>() {
                                if v <= 100 {
                                    best = Some(v as f64 / 100.0);
                                }
                            }
                        }
                        keep_from = i;
                    } else {
                        i += 1;
                        keep_from = i;
                    }
                }
                self.text = t[keep_from.min(t.len())..].to_string();
                if let Some(p) = best {
                    if p > self.last {
                        self.last = p;
                        out.push(p);
                    }
                }
            }
            Progress::Ffmpeg | Progress::Lines => {
                self.text.push_str(&String::from_utf8_lossy(chunk));
                while let Some(i) = self.text.find('\n') {
                    let line: String = self.text.drain(..=i).collect();
                    let line = line.trim();
                    let p = if self.kind == Progress::Lines {
                        line.strip_prefix("PROGRESS ").and_then(|v| v.trim().parse::<f64>().ok())
                    } else if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
                        let us: f64 = v.trim().parse().unwrap_or(0.0);
                        self.duration_s.map(|d| if d > 0.0 { us / 1e6 / d } else { 0.0 })
                    } else if let Some(v) = line.strip_prefix("duration_hint=") {
                        self.duration_s = v.trim().parse().ok();
                        None
                    } else if line == "progress=end" {
                        Some(1.0)
                    } else {
                        None
                    };
                    if let Some(p) = p {
                        let p = p.clamp(0.0, 1.0);
                        if p > self.last {
                            self.last = p;
                            out.push(p);
                        }
                    }
                }
            }
        }
        out
    }
}

/// A tool run for the caps: short limits, no cancellation, stdout kept.
pub async fn query(modules_dir: &Path, tool: &str, args: &[&str], tmp: &Path) -> Result<String, String> {
    struct Quiet;
    impl Sink for Quiet {
        fn log(&self, _: &str) {}
        fn progress(&self, _: f64) {}
    }
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    crate::winjob::create_low_dir(tmp).map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
    let spec = RunSpec { modules_dir, tool, args: &args, cwd: tmp, tmp, limits: JobLimits { memory_bytes: 2 << 30, cpu_seconds: 120, processes: 2 }, wall: Duration::from_secs(60), capture_stdout: 32 << 20, progress: Progress::None };
    let o = run(spec, CancellationToken::new(), Arc::new(Quiet)).await?;
    if o.exit_code != Some(0) {
        return Err(format!("{tool} {} failed (exit {:?}{}{}): {}", args.join(" "), o.exit_code, if o.timed_out { ", timed out" } else { "" }, o.killed_reason.as_deref().map(|r| format!(", {r}")).unwrap_or_default(), o.stderr_tail.join(" | ")));
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gdal_progress() {
        let mut p = ProgressParser::new(Progress::Gdal);
        assert_eq!(p.feed_stdout(b"Input file size is 100, 100\n0...10...2"), vec![0.1]);
        assert_eq!(p.feed_stdout(b"0...30"), vec![0.2]);
        assert_eq!(p.feed_stdout(b"...40...50...60...70...80...90...100 - done.\n"), vec![1.0]);
    }

    #[test]
    fn ffmpeg_progress() {
        assert_eq!(ffmpeg_duration("  Duration: 00:01:40.00, start: 1.4, bitrate: 2 kb/s"), Some(100.0));
        let mut p = ProgressParser::new(Progress::Ffmpeg);
        p.duration_s = Some(100.0);
        assert_eq!(p.feed_stdout(b"frame=10\nout_time_us=50000000\n"), vec![0.5]);
        assert_eq!(p.feed_stdout(b"progress=end\n"), vec![1.0]);
    }

    #[test]
    fn line_progress() {
        let mut p = ProgressParser::new(Progress::Lines);
        assert_eq!(p.feed_stdout(b"PROGRESS 0.25\nhello\nPROGRESS 0.5\n"), vec![0.25, 0.5]);
    }
}
