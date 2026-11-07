//! Starting one host, confined, with its protocol pipes (REQ-GAP-25).
//!
//! The usual tool sandbox (`winjob.rs`) is not enough here. Low integrity stops writes but neither
//! reads nor sockets, and a plug-in is native code the environment's proxy settings do not bind.
//! So the host runs tighter than a tool:
//!
//!   Windows: an AppContainer with no capabilities, which has no network at all (loopback
//!   included) and reads only what is granted to it, and which is Low integrity by nature, in a
//!   Job Object with the same limits as a tool and a process cap of one, with child processes
//!   refused as well. Everything the host needs is copied into the run folder, and only that
//!   folder is granted. A new container per session; `Sandboxed::drop` deletes its profile.
//!
//!   Linux: `pre_exec` sets the rlimits, the parent-death signal and a Landlock ruleset that also
//!   confines reads to the run folder and the system's libraries; the host then installs a seccomp
//!   filter on itself (no sockets, no new processes) and proves it before it loads the plug-in.
//!   Without Landlock there is no session: the sandbox is all or nothing.
//!
//! The host reports what it sees of this in HELLO, and the sidecar refuses to go on if it is not
//! confined, so a mistake here ends in a refusal and not in an unconfined plug-in.

use crate::winjob::{JobLimits, ProcessJob};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Sandboxed {
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
    pub job: Arc<ProcessJob>,
    #[cfg(windows)]
    container: String,
    #[cfg(unix)]
    child: std::process::Child,
}

impl Sandboxed {
    /// Ends the host and everything it left running.
    pub fn stop(&mut self) {
        self.job.terminate(1);
        #[cfg(unix)]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl Drop for Sandboxed {
    fn drop(&mut self) {
        self.stop();
        #[cfg(windows)]
        win::delete_container(&self.container);
    }
}

/// Start `exe` in `run`, a folder this process made, with the plug-in's path as its one argument.
pub fn spawn(run: &Path, exe: &Path, plugin: &Path, limits: JobLimits) -> std::io::Result<Sandboxed> {
    #[cfg(windows)]
    return win::spawn(run, exe, plugin, limits);
    #[cfg(unix)]
    return unix::spawn(run, exe, plugin, limits);
}

/// A description of the sandbox for logs and the session's answer.
pub fn describe() -> String {
    #[cfg(windows)]
    return "AppContainer with no capabilities, Job Object".into();
    #[cfg(unix)]
    return format!("Landlock ABI {}, seccomp, rlimits", crate::winjob::unix::abi());
}

/// Remove what a sidecar that was killed left behind: a session's AppContainer profile is an entry
/// in the user's registry and a folder under LOCALAPPDATA, and only `Sandboxed::drop` removes it.
/// A profile's name holds the process that made it, so another sidecar's stay.
pub fn sweep() {
    #[cfg(windows)]
    if let Some(p) = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Packages")) {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let Some(pid) = n.strip_prefix("gwb.csmhost.").and_then(|r| r.split('.').next()) else { continue };
            if !pid.parse::<u32>().is_ok_and(win::process_alive) {
                win::delete_container(&n);
            }
        }
    }
}

/// The folders a run may write in.
pub fn scratch(run: &Path) -> PathBuf {
    run.join("tmp")
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::winjob::unix as lock;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    pub fn spawn(run: &Path, exe: &Path, plugin: &Path, limits: JobLimits) -> std::io::Result<Sandboxed> {
        if !crate::winjob::low_integrity() {
            return Err(std::io::Error::other("the plug-in host never runs with the sandbox turned off"));
        }
        let ruleset = lock::strict_ruleset(run).ok_or_else(|| std::io::Error::other("this kernel has no Landlock, and the plug-in host does not run without it"))?;
        let fd = ruleset.0;
        let (mem, cpu) = (limits.memory_bytes, limits.cpu_seconds);
        let mut cmd = Command::new(exe);
        cmd.arg(plugin).current_dir(scratch(run)).env_clear().env("TMPDIR", scratch(run)).env("HOME", scratch(run)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
        // Runs in the child between fork and exec: async-signal-safe calls only.
        unsafe {
            cmd.pre_exec(move || {
                let fail = || Err(std::io::Error::last_os_error());
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong) != 0 {
                    return fail();
                }
                let lim = |res, v: u64| libc::setrlimit(res, &libc::rlimit { rlim_cur: v as libc::rlim_t, rlim_max: v as libc::rlim_t });
                if lim(libc::RLIMIT_AS, mem) != 0 || lim(libc::RLIMIT_CORE, 0) != 0 || lim(libc::RLIMIT_NOFILE, 64) != 0 || lim(libc::RLIMIT_FSIZE, 1 << 30) != 0 {
                    return fail();
                }
                if libc::setrlimit(libc::RLIMIT_CPU, &libc::rlimit { rlim_cur: cpu as libc::rlim_t, rlim_max: (cpu + 5) as libc::rlim_t }) != 0 {
                    return fail();
                }
                if lock::restrict_self(fd) != 0 {
                    return fail();
                }
                Ok(())
            });
        }
        // The host was copied a moment ago, and a fork in another thread (a second session starting)
        // can hold that copy's write handle until its own exec: the kernel then answers ETXTBSY.
        // It clears as soon as that exec runs.
        let mut tries = 0;
        let mut child = loop {
            match cmd.spawn() {
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && tries < 40 => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                other => break other?,
            }
        };
        drop(ruleset);
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let job = Arc::new(ProcessJob::of_group(child.id() as i32));
        Ok(Sandboxed { stdin: Box::new(stdin), stdout: Box::new(stdout), job, child })
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Security::Authorization::*;
    use windows_sys::Win32::Security::Isolation::*;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::*;

    const HRESULT_ALREADY_EXISTS: i32 = 0x800700B7u32 as i32;
    const PROCESS_CREATION_CHILD_PROCESS_RESTRICTED: u32 = 1;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }
    fn w(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn last() -> std::io::Error {
        std::io::Error::last_os_error()
    }

    struct Sid(PSID);
    impl Drop for Sid {
        fn drop(&mut self) {
            unsafe { FreeSid(self.0) };
        }
    }
    struct H(HANDLE);
    impl Drop for H {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    pub fn process_alive(pid: u32) -> bool {
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE;
            CloseHandle(h);
            ok
        }
    }

    pub fn delete_container(name: &str) {
        unsafe { DeleteAppContainerProfile(w(name).as_ptr()) };
    }

    fn container(name: &str) -> std::io::Result<Sid> {
        let mut sid: PSID = std::ptr::null_mut();
        let n = w(name);
        let d = w("GIS Workbench CSM plug-in host");
        let hr = unsafe { CreateAppContainerProfile(n.as_ptr(), d.as_ptr(), d.as_ptr(), std::ptr::null(), 0, &mut sid) };
        if hr == HRESULT_ALREADY_EXISTS {
            let hr = unsafe { DeriveAppContainerSidFromAppContainerName(n.as_ptr(), &mut sid) };
            if hr != 0 {
                return Err(std::io::Error::other(format!("the AppContainer's SID could not be derived ({hr:#x})")));
            }
        } else if hr != 0 {
            return Err(std::io::Error::other(format!("the AppContainer could not be made ({hr:#x})")));
        }
        Ok(Sid(sid))
    }

    /// Add an allow entry for the container to `path`, inherited by what is in it.
    fn grant(path: &Path, sid: PSID, access: u32) -> std::io::Result<()> {
        unsafe {
            let p = wide(path.as_os_str());
            let mut old: *mut ACL = std::ptr::null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let r = GetNamedSecurityInfoW(p.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), &mut old, std::ptr::null_mut(), &mut sd);
            if r != 0 {
                return Err(std::io::Error::from_raw_os_error(r as i32));
            }
            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions = access;
            ea.grfAccessMode = GRANT_ACCESS;
            ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
            ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            ea.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            ea.Trustee.ptstrName = sid as *mut u16;
            let mut new: *mut ACL = std::ptr::null_mut();
            let r = SetEntriesInAclW(1, &ea, old, &mut new);
            let r = if r == 0 { SetNamedSecurityInfoW(p.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), new, std::ptr::null()) } else { r };
            LocalFree(new as HLOCAL);
            LocalFree(sd as HLOCAL);
            if r != 0 {
                return Err(std::io::Error::from_raw_os_error(r as i32));
            }
            Ok(())
        }
    }

    fn pipe() -> std::io::Result<(H, H)> {
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
        let (mut r, mut wr): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        if unsafe { CreatePipe(&mut r, &mut wr, &sa, 1 << 16) } == 0 {
            return Err(last());
        }
        Ok((H(r), H(wr)))
    }

    pub fn spawn(run: &Path, exe: &Path, plugin: &Path, limits: JobLimits) -> std::io::Result<Sandboxed> {
        if !crate::winjob::low_integrity() {
            return Err(std::io::Error::other("the plug-in host never runs with the sandbox turned off"));
        }
        let name = format!("gwb.csmhost.{}.{}", std::process::id(), crate::util::random_hex(8));
        let sid = container(&name)?;
        let done = (|| {
            grant(run, sid.0, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)?;
            grant(&scratch(run), sid.0, FILE_ALL_ACCESS)?;
            start(&name, sid.0, run, exe, plugin, limits)
        })();
        if done.is_err() {
            delete_container(&name);
        }
        done
    }

    fn start(name: &str, sid: PSID, run: &Path, exe: &Path, plugin: &Path, limits: JobLimits) -> std::io::Result<Sandboxed> {
        unsafe {
            let (in_r, in_w) = pipe()?;
            let (out_r, out_w) = pipe()?;
            // Only the child's ends travel.
            SetHandleInformation(in_w.0, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(out_r.0, HANDLE_FLAG_INHERIT, 0);
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
            let nul = H(CreateFileW(w("NUL").as_ptr(), FILE_GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, std::ptr::null_mut()));
            if nul.0 == INVALID_HANDLE_VALUE {
                return Err(last());
            }
            let mut list = [in_r.0, out_w.0, nul.0];

            let mut size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 3, 0, &mut size);
            let mut attr_mem = vec![0u64; size.div_ceil(8)];
            let attrs = attr_mem.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attrs, 3, 0, &mut size) == 0 {
                return Err(last());
            }
            let mut caps: SECURITY_CAPABILITIES = std::mem::zeroed();
            caps.AppContainerSid = sid;
            let child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
            let set = |attr: usize, v: *const core::ffi::c_void, n: usize| UpdateProcThreadAttribute(attrs, 0, attr, v, n, std::ptr::null_mut(), std::ptr::null());
            let ok = set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, &caps as *const _ as *const _, std::mem::size_of_val(&caps)) != 0
                && set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, list.as_mut_ptr() as *const _, std::mem::size_of_val(&list)) != 0
                && set(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY as usize, &child_policy as *const _ as *const _, 4) != 0;
            if !ok {
                let e = last();
                DeleteProcThreadAttributeList(attrs);
                return Err(e);
            }

            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = in_r.0;
            si.StartupInfo.hStdOutput = out_w.0;
            si.StartupInfo.hStdError = nul.0;
            si.lpAttributeList = attrs;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let exe_w = wide(exe.as_os_str());
            let mut cmdline = w(&format!("\"{}\" \"{}\"", exe.display(), plugin.display()));
            let cwd = wide(scratch(run).as_os_str());
            // The whole environment, as UTF-16 pairs ending in a second NUL.
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            let tmp = scratch(run).display().to_string();
            let mut env: Vec<u16> = Vec::new();
            // CreateProcess fails with error 203 for a container with no LOCALAPPDATA: it rewrites that
            // one to the container's own folder.
            let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| tmp.clone());
            for kv in [format!("LOCALAPPDATA={local}"), format!("SystemRoot={root}"), format!("TEMP={tmp}"), format!("TMP={tmp}")] {
                env.extend(kv.encode_utf16());
                env.push(0);
            }
            env.push(0);
            let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT;
            let made = CreateProcessW(exe_w.as_ptr(), cmdline.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1, flags, env.as_ptr() as *const _, cwd.as_ptr(), &si.StartupInfo, &mut pi);
            let e = last();
            DeleteProcThreadAttributeList(attrs);
            if made == 0 {
                return Err(std::io::Error::other(format!("the plug-in host could not start in its sandbox: {e}")));
            }
            let process = H(pi.hProcess);
            let thread = H(pi.hThread);
            let job = match crate::winjob::new_job(limits) {
                Ok(j) => j,
                Err(e) => {
                    TerminateProcess(process.0, 1);
                    return Err(e);
                }
            };
            if !job.adopt(process.0) {
                let e = last();
                TerminateProcess(process.0, 1);
                return Err(e);
            }
            if ResumeThread(thread.0) == u32::MAX {
                let e = last();
                job.terminate(1);
                return Err(e);
            }
            let stdin = File::from_raw_handle(in_w.0 as _);
            let stdout = File::from_raw_handle(out_r.0 as _);
            std::mem::forget(in_w);
            std::mem::forget(out_r);
            Ok(Sandboxed { stdin: Box::new(stdin), stdout: Box::new(stdout), job: Arc::new(job), container: name.to_string() })
        }
    }
}
