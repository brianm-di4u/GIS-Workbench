//! Tool processes run inside a Windows Job Object (REQ-SDC-04, SDP-2.1 §3.3 item 6): memory and
//! CPU-time caps, a process-count cap, UI restrictions, and kill-on-close, so a cancelled job or a
//! sidecar that exits takes the whole process tree with it.
//!
//! The process is created suspended, put in the job, its token lowered to Low integrity, then
//! resumed, so not even its first instruction (or a grandchild) runs outside the job or above Low.
//! A Low-integrity process may read the user's files but write only to objects labelled Low: the
//! job folder (`label_low`), where its TEMP, profile and outputs are. A tool exploited through a
//! crafted input can then not write to the user's documents, profile or start-up folders.
//! GWB_SIDECAR_TOOL_IL=medium turns the lowering off (diagnosis only).
//!
//! On Linux (P16) the same guarantees come from other means (`unix` below): the tool leads its own
//! process group (cancel and drop kill the group), dies with the sidecar (PR_SET_PDEATHSIG), and
//! has per-process address-space and CPU-time caps (setrlimit). Landlock takes the place of Low
//! integrity: reads anywhere, writes only beneath the folders made with `create_low_dir`, no TCP
//! at all (ABI 4+) and no signals or abstract sockets outside the tool (ABI 6+). Linux has no
//! per-job process cap without cgroups, so `processes` is not enforced there.

use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Copy)]
pub struct JobLimits {
    pub memory_bytes: u64,
    pub cpu_seconds: u64,
    pub processes: u32,
}

pub struct ProcessJob {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    pgid: i32,
    #[cfg(unix)]
    peak: std::sync::Arc<std::sync::atomic::AtomicU64>,
    #[cfg(unix)]
    sampler: Option<tokio::task::JoinHandle<()>>,
}

unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// Kill every process in the job (cancel kills the tree).
    pub fn terminate(&self, code: u32) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, code);
        }
        #[cfg(unix)]
        {
            let _ = code;
            if self.pgid > 0 {
                unsafe { libc::killpg(self.pgid, libc::SIGKILL) };
            }
        }
    }

    /// A job for a process group already started (the plug-in host on Linux).
    #[cfg(unix)]
    pub fn of_group(pgid: i32) -> ProcessJob {
        ProcessJob { pgid, peak: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)), sampler: None }
    }

    /// Put a suspended process in this job.
    ///
    /// # Safety
    /// `process` must be an open process handle.
    #[cfg(windows)]
    pub unsafe fn adopt(&self, process: windows_sys::Win32::Foundation::HANDLE) -> bool {
        unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.handle, process) != 0 }
    }

    /// Peak memory used by the job so far, in bytes.
    pub fn peak_memory(&self) -> u64 {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            let mut ret = 0u32;
            if QueryInformationJobObject(self.handle, JobObjectExtendedLimitInformation, &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32, &mut ret) != 0 {
                return info.PeakJobMemoryUsed as u64;
            }
        }
        // The largest address space a process of the group reached (what RLIMIT_AS caps).
        #[cfg(unix)]
        {
            let now = unix::group_peak(self.pgid);
            return self.peak.fetch_max(now, std::sync::atomic::Ordering::Relaxed).max(now);
        }
        #[allow(unreachable_code)]
        0
    }

    /// Processes still alive in the job.
    pub fn active_processes(&self) -> u32 {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let mut ret = 0u32;
            if QueryInformationJobObject(self.handle, JobObjectBasicAccountingInformation, &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32, &mut ret) != 0 {
                return info.ActiveProcesses;
            }
        }
        #[cfg(unix)]
        return unix::group_members(self.pgid).len() as u32;
        #[allow(unreachable_code)]
        0
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            // KILL_ON_JOB_CLOSE: closing the last handle ends whatever is still running.
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
        #[cfg(unix)]
        {
            // As KILL_ON_JOB_CLOSE: whatever is left of the group dies with the job.
            if let Some(s) = self.sampler.take() {
                s.abort();
            }
            self.terminate(1);
        }
    }
}

/// Create `dir` (its parents as usual) labelled Low integrity, with full access for its owner, so
/// Low-integrity tools may write in it and in what they create there. A label given at creation
/// needs no rights beyond creating the folder (labelling an existing one needs WRITE_OWNER, which
/// a data folder outside the user's profile may not grant). An existing folder is labelled.
pub fn create_low_dir(dir: &std::path::Path) -> std::io::Result<()> {
    if dir.exists() {
        return label_low(dir);
    }
    if let Some(p) = dir.parent() {
        std::fs::create_dir_all(p)?;
    }
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::Security::Authorization::*;
        use windows_sys::Win32::Security::*;
        use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
        let sddl: Vec<u16> = "D:(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)S:(ML;OICI;NW;;;LW)".encode_utf16().chain(Some(0)).collect();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
        let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = CreateDirectoryW(path.as_ptr(), &sa);
        let e = std::io::Error::last_os_error();
        LocalFree(sd as HLOCAL);
        if ok == 0 && !dir.exists() {
            return Err(e);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if let Err(e) = std::fs::create_dir(dir) {
            if !dir.is_dir() {
                return Err(e);
            }
        }
        label_low(dir)
    }
}

/// Label `dir` (and what is later created in it) Low integrity, so Low-integrity tools may write there.
pub fn label_low(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::Security::Authorization::*;
        use windows_sys::Win32::Security::*;
        let sddl: Vec<u16> = "S:(ML;OICI;NW;;;LW)".encode_utf16().chain(Some(0)).collect();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let (mut present, mut defaulted) = (0i32, 0i32);
        let mut sacl: *mut ACL = std::ptr::null_mut();
        let ok = GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted);
        let path: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        let r = if ok == 0 { GetLastError() } else { SetNamedSecurityInfoW(path.as_ptr(), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null(), sacl) };
        LocalFree(sd as HLOCAL);
        if r != 0 {
            return Err(std::io::Error::from_raw_os_error(r as i32));
        }
    }
    // Linux has no labels: the folder joins the set Landlock lets tools write beneath.
    #[cfg(unix)]
    unix::allow_writes(dir);
    #[cfg(not(any(windows, unix)))]
    let _ = dir;
    Ok(())
}

/// Lower a (suspended) process's primary token to Low integrity (S-1-16-4096).
#[cfg(windows)]
unsafe fn lower_to_low(process: windows_sys::Win32::Foundation::HANDLE) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::System::Threading::OpenProcessToken;
    let mut tok: HANDLE = std::ptr::null_mut();
    if OpenProcessToken(process, TOKEN_ADJUST_DEFAULT | TOKEN_QUERY, &mut tok) == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let s: Vec<u16> = "S-1-16-4096".encode_utf16().chain(Some(0)).collect();
    let mut sid: PSID = std::ptr::null_mut();
    let mut r = Ok(());
    if ConvertStringSidToSidW(s.as_ptr(), &mut sid) == 0 {
        r = Err(std::io::Error::last_os_error());
    } else {
        let tml = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: 0x20 /* SE_GROUP_INTEGRITY */ } };
        if SetTokenInformation(tok, TokenIntegrityLevel, &tml as *const _ as *const _, (std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32) + GetLengthSid(sid)) == 0 {
            r = Err(std::io::Error::last_os_error());
        }
        LocalFree(sid as HLOCAL);
    }
    CloseHandle(tok);
    r
}

/// Whether tool processes run at Low integrity (the default).
pub fn low_integrity() -> bool {
    !std::env::var("GWB_SIDECAR_TOOL_IL").is_ok_and(|v| v.eq_ignore_ascii_case("medium"))
}

/// A new job with `limits`, UI restrictions and kill-on-close.
#[cfg(windows)]
pub fn new_job(limits: JobLimits) -> std::io::Result<ProcessJob> {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let pj = ProcessJob { handle: job };
        let mut ext: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_JOB_TIME;
        ext.BasicLimitInformation.ActiveProcessLimit = limits.processes.max(1);
        ext.JobMemoryLimit = limits.memory_bytes as usize;
        ext.BasicLimitInformation.PerJobUserTimeLimit = (limits.cpu_seconds.saturating_mul(10_000_000)) as i64;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &ext as *const _ as *const _, std::mem::size_of_val(&ext) as u32) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS | JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
        };
        SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui as *const _ as *const _, std::mem::size_of_val(&ui) as u32);
        Ok(pj)
    }
}

/// Spawn `cmd` (already given its program, argument array, environment and folder) inside a new
/// job with `limits`. stdin is closed; stdout and stderr are piped.
pub fn spawn_in_job(mut cmd: Command, limits: JobLimits) -> std::io::Result<(Child, ProcessJob)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::*;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        unsafe {
            let pj = new_job(limits)?;
            let job = pj.handle;
            let mut child = cmd.spawn()?;
            let ph = match child.raw_handle() {
                Some(h) => h as HANDLE,
                None => return Err(std::io::Error::other("the tool exited before it was started")),
            };
            if AssignProcessToJobObject(job, ph) == 0 {
                let e = std::io::Error::last_os_error();
                let _ = child.start_kill();
                return Err(e);
            }
            if low_integrity() {
                if let Err(e) = lower_to_low(ph) {
                    pj.terminate(1);
                    return Err(std::io::Error::other(format!("could not lower the tool to Low integrity: {e}")));
                }
            }
            let pid = child.id().unwrap_or(0);
            if !resume_process(pid) {
                pj.terminate(1);
                return Err(std::io::Error::other("could not start the tool's main thread"));
            }
            Ok((child, pj))
        }
    }
    #[cfg(unix)]
    {
        let ruleset = if low_integrity() { unix::ruleset() } else { None };
        let fd = ruleset.as_ref().map(|r| r.0).unwrap_or(-1);
        let (mem, cpu) = (limits.memory_bytes, limits.cpu_seconds);
        cmd.process_group(0);
        // Runs in the child between fork and exec: async-signal-safe calls only (no allocation).
        unsafe {
            cmd.pre_exec(move || {
                let fail = || Err(std::io::Error::last_os_error());
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong) != 0 {
                    return fail();
                }
                let lim = |res, v: u64| libc::setrlimit(res, &libc::rlimit { rlim_cur: v as libc::rlim_t, rlim_max: v as libc::rlim_t });
                if mem > 0 && lim(libc::RLIMIT_AS, mem) != 0 {
                    return fail();
                }
                // SIGXCPU at the cap; the hard limit (SIGKILL) a few seconds later.
                if cpu > 0 && libc::setrlimit(libc::RLIMIT_CPU, &libc::rlimit { rlim_cur: cpu as libc::rlim_t, rlim_max: (cpu + 5) as libc::rlim_t }) != 0 {
                    return fail();
                }
                lim(libc::RLIMIT_CORE, 0);
                if fd >= 0 && unix::restrict_self(fd) != 0 {
                    return fail();
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        drop(ruleset);
        let pgid = child.id().map(|p| p as i32).unwrap_or(0);
        let peak = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        // VmPeak is gone once a process is reaped, so sample it while the group runs.
        let sampler = tokio::runtime::Handle::try_current().ok().map(|h| {
            let p = peak.clone();
            h.spawn(async move {
                loop {
                    p.fetch_max(unix::group_peak(pgid), std::sync::atomic::Ordering::Relaxed);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            })
        });
        Ok((child, ProcessJob { pgid, peak, sampler }))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = limits;
        let child = cmd.spawn()?;
        Ok((child, ProcessJob {}))
    }
}

/// How tool processes are confined on this machine (logged at start and shown in the window).
pub fn confinement() -> String {
    let off = if low_integrity() { "" } else { " (lowering turned off by GWB_SIDECAR_TOOL_IL=medium)" };
    #[cfg(windows)]
    let s = format!("Job Object limits; tools at Low integrity{off}");
    #[cfg(unix)]
    let s = match unix::abi() {
        0 => format!("process group, rlimits; Landlock is not available on this kernel, so tools may write wherever you can{off}"),
        a => format!("process group, rlimits; Landlock ABI {a}: writes only in job folders{}{}{off}", if a >= 4 { ", no TCP" } else { "" }, if a >= 6 { ", signals and abstract sockets scoped" } else { "" }),
    };
    #[cfg(not(any(windows, unix)))]
    let s = format!("none{off}");
    s
}

/// Linux: process groups, rlimits and Landlock (raw syscalls; the ruleset is built in the parent,
/// so the child only calls prctl and landlock_restrict_self).
#[cfg(unix)]
pub(crate) mod unix {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    static WRITABLE: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

    pub fn allow_writes(dir: &Path) {
        let d = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let mut w = WRITABLE.lock().unwrap();
        w.retain(|p| p.is_dir());
        if !w.contains(&d) {
            w.push(d);
        }
    }

    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: libc::c_int = 1;
    const FS_WRITE_FILE: u64 = 1 << 1;
    const FS_REMOVE_DIR: u64 = 1 << 4;
    const FS_REMOVE_FILE: u64 = 1 << 5;
    const FS_MAKE_CHAR: u64 = 1 << 6;
    const FS_MAKE_DIR: u64 = 1 << 7;
    const FS_MAKE_REG: u64 = 1 << 8;
    const FS_MAKE_SOCK: u64 = 1 << 9;
    const FS_MAKE_FIFO: u64 = 1 << 10;
    const FS_MAKE_BLOCK: u64 = 1 << 11;
    const FS_MAKE_SYM: u64 = 1 << 12;
    const FS_REFER: u64 = 1 << 13;
    const FS_TRUNCATE: u64 = 1 << 14;
    const NET_BIND_TCP: u64 = 1 << 0;
    const NET_CONNECT_TCP: u64 = 1 << 1;
    const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
    const SCOPE_SIGNAL: u64 = 1 << 1;

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
        scoped: u64,
    }

    #[repr(C, packed)]
    struct PathBeneathAttr {
        allowed_access: u64,
        parent_fd: i32,
    }

    /// The kernel's Landlock ABI version, 0 when it has none (or it is turned off).
    pub fn abi() -> i64 {
        let v = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<RulesetAttr>(), 0usize, CREATE_RULESET_VERSION) };
        v.max(0)
    }

    pub struct Ruleset(pub libc::c_int);

    impl Drop for Ruleset {
        fn drop(&mut self) {
            unsafe { libc::close(self.0) };
        }
    }

    /// A ruleset that handles every kind of write (and TCP, signals, abstract sockets where the
    /// ABI has them) and allows writes only beneath the writable folders, /dev/shm (POSIX
    /// semaphores) and to existing device files such as /dev/null. None when Landlock is absent.
    pub fn ruleset() -> Option<Ruleset> {
        let abi = abi();
        if abi < 1 {
            return None;
        }
        let mut fs = FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM;
        if abi >= 2 {
            fs |= FS_REFER;
        }
        if abi >= 3 {
            fs |= FS_TRUNCATE;
        }
        let attr = RulesetAttr { handled_access_fs: fs, handled_access_net: if abi >= 4 { NET_BIND_TCP | NET_CONNECT_TCP } else { 0 }, scoped: if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 } };
        let size = if abi >= 6 { 24 } else if abi >= 4 { 16 } else { 8 };
        let fd = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, size as usize, 0u32) };
        if fd < 0 {
            return None;
        }
        let rs = Ruleset(fd as libc::c_int);
        let dirs: Vec<PathBuf> = WRITABLE.lock().unwrap().iter().filter(|p| p.is_dir()).cloned().collect();
        let shm_rights = FS_WRITE_FILE | FS_MAKE_REG | FS_REMOVE_FILE | (fs & FS_TRUNCATE);
        let rules = dirs.iter().map(|d| (d.as_path(), fs)).chain([(Path::new("/dev/shm"), shm_rights), (Path::new("/dev"), FS_WRITE_FILE)]);
        for (p, access) in rules {
            let Ok(c) = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()) else { continue };
            let pfd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC | libc::O_DIRECTORY) };
            if pfd < 0 {
                continue;
            }
            let rule = PathBeneathAttr { allowed_access: access & fs, parent_fd: pfd };
            unsafe {
                libc::syscall(libc::SYS_landlock_add_rule, rs.0, RULE_PATH_BENEATH, &rule as *const PathBeneathAttr, 0u32);
                libc::close(pfd);
            }
        }
        Some(rs)
    }

    const FS_EXECUTE: u64 = 1 << 0;
    const FS_READ_FILE: u64 = 1 << 2;
    const FS_READ_DIR: u64 = 1 << 3;

    /// For the plug-in host: as `ruleset`, and reads confined too: the run folder (writes only in
    /// its `tmp`), the system's libraries, and /dev/null. None without Landlock ABI 4 (TCP rules).
    pub fn strict_ruleset(run: &Path) -> Option<Ruleset> {
        let abi = abi();
        if abi < 4 {
            return None;
        }
        let write = FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM | FS_REFER | FS_TRUNCATE;
        let read = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;
        let fs = write | read;
        let attr = RulesetAttr { handled_access_fs: fs, handled_access_net: NET_BIND_TCP | NET_CONNECT_TCP, scoped: if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 } };
        let size = if abi >= 6 { 24 } else { 16 };
        let fd = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, size as usize, 0u32) };
        if fd < 0 {
            return None;
        }
        let rs = Ruleset(fd as libc::c_int);
        let tmp = run.join("tmp");
        // Paths may be absent on a given system; a rule that cannot be made grants nothing.
        let rules: Vec<(PathBuf, u64, bool)> = vec![(run.to_path_buf(), read, true), (tmp, fs, true), ("/usr".into(), read, true), ("/lib".into(), read, true), ("/lib64".into(), read, true), ("/etc/ld.so.cache".into(), FS_READ_FILE, false), ("/dev/null".into(), FS_READ_FILE | FS_WRITE_FILE, false)];
        for (p, access, dir) in rules {
            let Ok(c) = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()) else { continue };
            let flags = libc::O_PATH | libc::O_CLOEXEC | if dir { libc::O_DIRECTORY } else { 0 };
            let pfd = unsafe { libc::open(c.as_ptr(), flags) };
            if pfd < 0 {
                continue;
            }
            let rule = PathBeneathAttr { allowed_access: access, parent_fd: pfd };
            unsafe {
                libc::syscall(libc::SYS_landlock_add_rule, rs.0, RULE_PATH_BENEATH, &rule as *const PathBeneathAttr, 0u32);
                libc::close(pfd);
            }
        }
        Some(rs)
    }

    /// In the child: no new privileges, then enforce the ruleset. Returns 0 on success.
    pub fn restrict_self(fd: libc::c_int) -> libc::c_long {
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return -1;
            }
            libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32)
        }
    }

    /// Live (non-zombie) processes whose process group is `pgid`.
    pub fn group_members(pgid: i32) -> Vec<i32> {
        let mut out = Vec::new();
        if pgid <= 0 {
            return out;
        }
        let Ok(rd) = std::fs::read_dir("/proc") else { return out };
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            // pid (comm) state ppid pgrp ...: comm may hold spaces and parentheses.
            let Some(rest) = stat.rfind(')').map(|i| &stat[i + 1..]) else { continue };
            let f: Vec<&str> = rest.split_whitespace().collect();
            if f.len() > 2 && f[0] != "Z" && f[2].parse::<i32>().ok() == Some(pgid) {
                out.push(pid);
            }
        }
        out
    }

    /// The largest VmPeak (bytes) among the group's processes now.
    pub fn group_peak(pgid: i32) -> u64 {
        group_members(pgid)
            .into_iter()
            .filter_map(|pid| {
                let s = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
                let l = s.lines().find(|l| l.starts_with("VmPeak:"))?;
                l.split_whitespace().nth(1)?.parse::<u64>().ok().map(|kb| kb * 1024)
            })
            .max()
            .unwrap_or(0)
    }
}

/// Resume every thread of a process created suspended (there is one: its main thread).
#[cfg(windows)]
unsafe fn resume_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::*;
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if snap == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut te: THREADENTRY32 = std::mem::zeroed();
    te.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0;
    if Thread32First(snap, &mut te) != 0 {
        loop {
            if te.th32OwnerProcessID == pid {
                let th = OpenThread(THREAD_SUSPEND_RESUME, 0, te.th32ThreadID);
                if !th.is_null() {
                    if ResumeThread(th) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(th);
                }
            }
            if Thread32Next(snap, &mut te) == 0 {
                break;
            }
        }
    }
    CloseHandle(snap);
    resumed > 0
}
