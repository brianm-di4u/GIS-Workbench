//! The command-line runner's browser (REG-150): the user's installed Chrome or Edge, started
//! headless with `--remote-debugging-pipe`, so the DevTools protocol runs over two anonymous pipes
//! (the browser's file descriptors 3 and 4) and nothing listens on any port. It gets a fresh
//! profile folder, runs inside a Job Object (Windows) or its own process group (Linux), and is
//! killed with everything it started when the runner ends.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// The installed browser to drive: `explicit` when given, else Chrome, then Edge, in their usual
/// install locations (Windows) or on PATH (Linux).
pub fn find_browser(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        return if p.is_file() {
            Ok(p.to_path_buf())
        } else {
            Err(format!("no browser at {}", p.display()))
        };
    }
    candidates()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "no installed Chrome or Edge was found; give one with --browser".to_string())
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    for rel in [
        "Google\\Chrome\\Application\\chrome.exe",
        "Microsoft\\Edge\\Application\\msedge.exe",
    ] {
        for r in &roots {
            out.push(r.join(rel));
        }
    }
    out
}

#[cfg(unix)]
fn candidates() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
    ]
    .iter()
    .flat_map(|n| dirs.iter().map(move |d| d.join(n)))
    .collect()
}

/// The browser's switches: headless, the pipe, a throwaway profile, and nothing that reaches out
/// on its own (updates, sync, metrics). WebGPU stays available to recipes that use it.
pub fn switches(profile: &Path) -> Vec<String> {
    vec![
        "--headless=new".into(),
        "--remote-debugging-pipe".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-sync".into(),
        "--disable-default-apps".into(),
        "--disable-extensions".into(),
        "--metrics-recording-only".into(),
        "--no-pings".into(),
        "--enable-unsafe-webgpu".into(),
        "--ignore-gpu-blocklist".into(),
        "about:blank".into(),
    ]
}

/// One message from the browser.
enum Inbound {
    Msg(Value),
    Closed(String),
}

/// A running browser and its DevTools pipe.
pub struct Browser {
    to: std::fs::File,
    from: Receiver<Inbound>,
    next: u64,
    proc: Proc,
    profile: PathBuf,
    /// Uncaught page exceptions seen so far (`Runtime.exceptionThrown`), for the log.
    pub exceptions: Vec<String>,
}

impl Browser {
    /// Start `exe` headless with a fresh profile under `profile` (created; removed on drop).
    pub fn launch(exe: &Path, profile: &Path) -> Result<Browser, String> {
        std::fs::create_dir_all(profile)
            .map_err(|e| format!("could not make the browser profile folder: {e}"))?;
        // Ours: write commands to `to`, read replies from `from_r`. The browser's: fd 3 reads
        // `cmd_r`, fd 4 writes `reply_w`.
        let (cmd_r, to) = os_pipe()?;
        let (from_r, reply_w) = os_pipe()?;
        let proc = spawn(exe, &switches(profile), cmd_r, reply_w)?;
        let (tx, rx) = channel();
        std::thread::spawn(move || read_loop(from_r, tx));
        Ok(Browser {
            to,
            from: rx,
            next: 0,
            proc,
            profile: profile.to_path_buf(),
            exceptions: Vec::new(),
        })
    }

    /// Send one command (to the browser, or to an attached page with `session`) and wait for its
    /// reply. A protocol error comes back as `Err` with the browser's message.
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let mut bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        bytes.push(0);
        self.to
            .write_all(&bytes)
            .map_err(|e| format!("the browser stopped taking commands ({e})"))?;
        let end = Instant::now() + timeout;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            match self.from.recv_timeout(left) {
                Ok(Inbound::Msg(m)) => {
                    if m.get("id").and_then(Value::as_u64) == Some(id) {
                        if let Some(e) = m.get("error") {
                            return Err(e
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("protocol error")
                                .to_string());
                        }
                        return Ok(m.get("result").cloned().unwrap_or(Value::Null));
                    }
                    self.event(&m);
                }
                Ok(Inbound::Closed(why)) => {
                    return Err(format!("the browser closed its DevTools pipe ({why})"));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "{method} had no reply within {} s",
                        timeout.as_secs()
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("the browser's DevTools pipe is gone".into());
                }
            }
        }
    }

    fn event(&mut self, m: &Value) {
        let method = m.get("method").and_then(Value::as_str);
        if method == Some("Page.javascriptDialogOpening") {
            // Nobody is there to answer an alert, confirm or prompt: dismiss it, or the page waits
            // for ever. No reply is awaited; it comes back with an id nothing asks for.
            self.next += 1;
            let mut msg = json!({ "id": self.next, "method": "Page.handleJavaScriptDialog", "params": { "accept": false } });
            if let Some(s) = m.get("sessionId") {
                msg["sessionId"] = s.clone();
            }
            if let Ok(mut bytes) = serde_json::to_vec(&msg) {
                bytes.push(0);
                let _ = self.to.write_all(&bytes);
            }
            if self.exceptions.len() < 50 {
                let text = m["params"]["message"].as_str().unwrap_or("");
                self.exceptions.push(format!(
                    "the page opened a dialog ({}), dismissed: {}",
                    m["params"]["type"].as_str().unwrap_or("JavaScript"),
                    text.lines().next().unwrap_or(text)
                ));
            }
        }
        if method == Some("Runtime.exceptionThrown") {
            let d = &m["params"]["exceptionDetails"];
            let text = d["exception"]["description"]
                .as_str()
                .or(d["text"].as_str())
                .unwrap_or("an exception");
            if self.exceptions.len() < 50 {
                self.exceptions
                    .push(text.lines().next().unwrap_or(text).to_string());
            }
        }
    }

    /// Attach to the browser's first page and return its session id.
    pub fn attach_page(&mut self) -> Result<String, String> {
        let t = self.call(
            "Target.getTargets",
            json!({}),
            None,
            Duration::from_secs(30),
        )?;
        let id = t["targetInfos"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["type"] == "page"))
            .and_then(|x| x["targetId"].as_str())
            .ok_or("the browser has no page")?
            .to_string();
        let a = self.call(
            "Target.attachToTarget",
            json!({ "targetId": id, "flatten": true }),
            None,
            Duration::from_secs(30),
        )?;
        a["sessionId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "no session for the page".to_string())
    }

    /// Evaluate `expr` in the page, awaiting a promise, and return its JSON value. A thrown error
    /// comes back as `Err` with its message.
    pub fn eval(&mut self, session: &str, expr: &str, timeout: Duration) -> Result<Value, String> {
        let r = self.call("Runtime.evaluate", json!({ "expression": expr, "awaitPromise": true, "returnByValue": true, "timeout": timeout.as_millis() as u64 }), Some(session), timeout + Duration::from_secs(5))?;
        if let Some(d) = r.get("exceptionDetails") {
            let msg = d["exception"]["description"]
                .as_str()
                .or(d["text"].as_str())
                .unwrap_or("the page threw");
            return Err(msg.lines().next().unwrap_or(msg).to_string());
        }
        Ok(r["result"]["value"].clone())
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        self.proc.kill();
        // The profile can stay locked for a moment after the browser goes.
        for _ in 0..20 {
            if std::fs::remove_dir_all(&self.profile).is_ok() || !self.profile.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Split the pipe into NUL-terminated JSON messages (the pipe transport's framing).
fn read_loop(mut from: std::fs::File, tx: std::sync::mpsc::Sender<Inbound>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match from.read(&mut chunk) {
            Ok(0) => {
                let _ = tx.send(Inbound::Closed("end of stream".into()));
                return;
            }
            Ok(n) => {
                // Only the new bytes can hold the next NUL: a large reply (a file's bytes) arrives
                // in many reads, and rescanning all of it each time is quadratic.
                let mut seen = buf.len();
                buf.extend_from_slice(&chunk[..n]);
                while let Some(k) = buf[seen..].iter().position(|&b| b == 0) {
                    let one: Vec<u8> = buf.drain(..=seen + k).collect();
                    seen = 0;
                    match serde_json::from_slice::<Value>(&one[..one.len() - 1]) {
                        Ok(v) => {
                            if tx.send(Inbound::Msg(v)).is_err() {
                                return;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Inbound::Closed(format!("unreadable message: {e}")));
                            return;
                        }
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Inbound::Closed(e.to_string()));
                return;
            }
        }
    }
}

// ---- Starting the browser with its two pipe ends as descriptors 3 and 4 ----

/// An anonymous pipe, (read end, write end), both synchronous and not inheritable. On Windows this
/// is CreatePipe: the browser reads its end with plain ReadFile, which an overlapped handle fails.
#[cfg(windows)]
fn os_pipe() -> Result<(std::fs::File, std::fs::File), String> {
    use std::os::windows::io::FromRawHandle;
    let (mut r, mut w) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { windows_sys::Win32::System::Pipes::CreatePipe(&mut r, &mut w, std::ptr::null(), 0) }
        == 0
    {
        return Err(format!(
            "no pipe for the browser: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe {
        (
            std::fs::File::from_raw_handle(r),
            std::fs::File::from_raw_handle(w),
        )
    })
}

#[cfg(unix)]
fn os_pipe() -> Result<(std::fs::File, std::fs::File), String> {
    let (r, w) = std::io::pipe().map_err(|e| format!("no pipe for the browser: {e}"))?;
    Ok((
        std::fs::File::from(std::os::fd::OwnedFd::from(r)),
        std::fs::File::from(std::os::fd::OwnedFd::from(w)),
    ))
}

#[cfg(windows)]
struct Proc {
    job: windows_sys::Win32::Foundation::HANDLE,
    process: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Proc {
    fn kill(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
            CloseHandle(self.process);
            CloseHandle(self.job);
        }
    }
}

/// A job whose only rule is that closing it kills everything in it, so the browser and every
/// process it started end with the runner, even if the runner is killed. Unlike the tool jobs
/// (winjob::new_job) it sets no UI restrictions: Chrome's own sandbox makes a desktop for its
/// renderers, which JOB_OBJECT_UILIMIT_DESKTOP forbids, and the browser then exits at once.
#[cfg(windows)]
fn kill_on_close_job() -> std::io::Result<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut ext: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &ext as *const _ as *const _,
            std::mem::size_of_val(&ext) as u32,
        ) == 0
        {
            let e = std::io::Error::last_os_error();
            windows_sys::Win32::Foundation::CloseHandle(job);
            return Err(e);
        }
        Ok(job)
    }
}

/// Windows quoting for one argument (the rules CommandLineToArgvW and the C runtime read back).
#[cfg(any(windows, test))]
pub fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return a.to_string();
    }
    let mut out = String::from('"');
    let mut slashes = 0usize;
    for c in a.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

/// The C runtime's inherited-descriptor block (STARTUPINFO lpReserved2): a count, one flag byte per
/// descriptor, then one handle per descriptor. Descriptors 0 to 2 are left to the standard handles;
/// 3 and 4 are open pipes.
#[cfg(any(windows, test))]
pub fn crt_fd_block(h3: usize, h4: usize) -> Vec<u8> {
    const FOPEN: u8 = 0x01;
    const FPIPE: u8 = 0x08;
    let n: u32 = 5;
    let mut b = Vec::with_capacity(4 + 5 + 5 * std::mem::size_of::<usize>());
    b.extend_from_slice(&n.to_le_bytes());
    b.extend_from_slice(&[0, 0, 0, FOPEN | FPIPE, FOPEN | FPIPE]);
    for h in [usize::MAX, usize::MAX, usize::MAX, h3, h4] {
        b.extend_from_slice(&h.to_le_bytes());
    }
    b
}

#[cfg(windows)]
fn spawn(
    exe: &Path,
    args: &[String],
    cmd_r: std::fs::File,
    reply_w: std::fs::File,
) -> Result<Proc, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::*;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let last = || std::io::Error::last_os_error().to_string();
    unsafe {
        let h3 = cmd_r.as_raw_handle() as HANDLE;
        let h4 = reply_w.as_raw_handle() as HANDLE;
        // Only the browser's two ends and NUL are inheritable, and the handle list below limits
        // inheritance to exactly those.
        for h in [h3, h4] {
            if SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
                return Err(last());
            }
        }
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        // GWB_RUN_BROWSER_LOG=<file>: the browser's own stderr goes there, for a browser that will not start.
        let dbg = std::env::var("GWB_RUN_BROWSER_LOG").ok();
        let nul_name: Vec<u16> = format!("{}\0", dbg.as_deref().unwrap_or("NUL"))
            .encode_utf16()
            .collect();
        let nul = CreateFileW(
            nul_name.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &sa,
            if dbg.is_some() {
                CREATE_ALWAYS
            } else {
                OPEN_EXISTING
            },
            0,
            std::ptr::null_mut(),
        );
        if nul == INVALID_HANDLE_VALUE {
            return Err(last());
        }
        let close_nul = || CloseHandle(nul);
        let mut list = [h3, h4, nul];
        let mut size = 0usize;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        let mut attr_mem = vec![0u64; size.div_ceil(8)];
        let attrs = attr_mem.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
            close_nul();
            return Err(last());
        }
        if UpdateProcThreadAttribute(
            attrs,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            list.as_mut_ptr() as *const _,
            std::mem::size_of_val(&list),
            std::ptr::null_mut(),
            std::ptr::null(),
        ) == 0
        {
            let e = last();
            DeleteProcThreadAttributeList(attrs);
            close_nul();
            return Err(e);
        }
        let mut fds = crt_fd_block(h3 as usize, h4 as usize);
        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = nul;
        si.StartupInfo.hStdOutput = nul;
        si.StartupInfo.hStdError = nul;
        si.StartupInfo.cbReserved2 = fds.len() as u16;
        si.StartupInfo.lpReserved2 = fds.as_mut_ptr();
        si.lpAttributeList = attrs;
        let exe_w: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
        let line = std::iter::once(quote_arg(&exe.display().to_string()))
            .chain(args.iter().map(|a| quote_arg(a)))
            .collect::<Vec<_>>()
            .join(" ");
        let mut line_w: Vec<u16> = line.encode_utf16().chain([0]).collect();
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let made = CreateProcessW(
            exe_w.as_ptr(),
            line_w.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            std::ptr::null(),
            std::ptr::null(),
            &si.StartupInfo,
            &mut pi,
        );
        let e = last();
        DeleteProcThreadAttributeList(attrs);
        close_nul();
        // The browser has its own copies now; ours must close, or the pipe never reports its end.
        drop(cmd_r);
        drop(reply_w);
        if made == 0 {
            return Err(format!("the browser did not start: {e}"));
        }
        let job = match kill_on_close_job() {
            Ok(j) => j,
            Err(e) => {
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                return Err(format!("no job object for the browser: {e}"));
            }
        };
        if AssignProcessToJobObject(job, pi.hProcess) == 0 {
            let e = last();
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            CloseHandle(job);
            return Err(format!("the browser could not join its job object: {e}"));
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        Ok(Proc {
            job,
            process: pi.hProcess,
        })
    }
}

#[cfg(unix)]
struct Proc {
    child: std::process::Child,
}

#[cfg(unix)]
impl Proc {
    fn kill(&mut self) {
        let pid = self.child.id() as i32;
        unsafe { libc::killpg(pid, libc::SIGKILL) };
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
fn spawn(
    exe: &Path,
    args: &[String],
    cmd_r: std::fs::File,
    reply_w: std::fs::File,
) -> Result<Proc, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let (r, w) = (cmd_r.as_raw_fd(), reply_w.as_raw_fd());
    let mut cmd = std::process::Command::new(exe);
    let err = match std::env::var_os("GWB_RUN_BROWSER_LOG") {
        Some(p) => std::fs::File::create(p)
            .map(std::process::Stdio::from)
            .map_err(|e| format!("GWB_RUN_BROWSER_LOG: {e}"))?,
        None => std::process::Stdio::null(),
    };
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(err);
    unsafe {
        cmd.pre_exec(move || {
            // Its own process group, killed with the runner, and the two pipe ends as 3 and 4.
            libc::setpgid(0, 0);
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            // dup the ends above 4 first, so placing one cannot overwrite the other.
            let r2 = libc::fcntl(r, libc::F_DUPFD_CLOEXEC, 10);
            let w2 = libc::fcntl(w, libc::F_DUPFD_CLOEXEC, 10);
            if r2 < 0 || w2 < 0 || libc::dup2(r2, 3) < 0 || libc::dup2(w2, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("the browser did not start: {e}"))?;
    drop(cmd_r);
    drop(reply_w);
    Ok(Proc { child })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_round_trips_the_hard_cases() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(
            quote_arg("C:\\Program Files\\x"),
            "\"C:\\Program Files\\x\""
        );
        assert_eq!(
            quote_arg("--user-data-dir=C:\\a b\\"),
            "\"--user-data-dir=C:\\a b\\\\\""
        );
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn the_descriptor_block_has_the_runtime_layout() {
        let b = crt_fd_block(0x1234, 0x5678);
        let w = std::mem::size_of::<usize>();
        assert_eq!(b.len(), 4 + 5 + 5 * w);
        assert_eq!(&b[..4], &5u32.to_le_bytes());
        assert_eq!(&b[4..9], &[0, 0, 0, 0x09, 0x09]);
        assert_eq!(&b[9 + 3 * w..9 + 4 * w], &0x1234usize.to_le_bytes());
        assert_eq!(&b[9 + 4 * w..], &0x5678usize.to_le_bytes());
    }

    #[test]
    fn switches_are_headless_on_a_pipe_with_no_port() {
        let s = switches(Path::new("/tmp/p"));
        assert!(s.contains(&"--headless=new".to_string()));
        assert!(s.contains(&"--remote-debugging-pipe".to_string()));
        assert!(!s.iter().any(|a| a.starts_with("--remote-debugging-port")
            || a.starts_with("--remote-debugging-address")));
    }
}
