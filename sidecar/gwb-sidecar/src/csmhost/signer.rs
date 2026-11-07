//! What the operating system says about a plug-in's signature. Recorded for the user to approve
//! with the SHA-256 (REQ-GAP-25). Nothing here decides for the user: an unsigned plug-in can still
//! be approved, and the window says what it is.
//!
//! Windows: WinVerifyTrust, from cached revocation data only (the sidecar makes no outbound
//! connection, REQ-SDC-14), then the signing certificate's name and thumbprint.
//! Linux: shared objects carry no signature a host can check, so the record says `unchecked`.

use gwb_sidecar_api::CsmSigner;
use std::path::Path;

#[cfg(not(windows))]
pub fn signer_of(_path: &Path) -> CsmSigner {
    CsmSigner { status: "unchecked".into(), subject: None, thumbprint: None }
}

#[cfg(windows)]
pub fn signer_of(path: &Path) -> CsmSigner {
    let status = verify(path);
    let (subject, thumbprint) = if status == "unsigned" { (None, None) } else { certificate(path).unwrap_or((None, None)) };
    CsmSigner { status: status.into(), subject, thumbprint }
}

#[cfg(windows)]
fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn verify(path: &Path) -> &'static str {
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::{CERT_E_CHAINING, CERT_E_UNTRUSTEDROOT, HWND, INVALID_HANDLE_VALUE, TRUST_E_BAD_DIGEST, TRUST_E_NOSIGNATURE, TRUST_E_PROVIDER_UNKNOWN, TRUST_E_SUBJECT_FORM_UNKNOWN, TRUST_E_SUBJECT_NOT_TRUSTED};
    use windows_sys::Win32::Security::WinTrust::*;
    // WINTRUST_ACTION_GENERIC_VERIFY_V2
    let mut action = GUID { data1: 0x00AAC56B, data2: 0xCD44, data3: 0x11D0, data4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE] };
    let w = wide(path);
    unsafe {
        let mut file: WINTRUST_FILE_INFO = std::mem::zeroed();
        file.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
        file.pcwszFilePath = w.as_ptr();
        let mut data: WINTRUST_DATA = std::mem::zeroed();
        data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
        data.dwUIChoice = WTD_UI_NONE;
        data.fdwRevocationChecks = WTD_REVOKE_NONE;
        data.dwUnionChoice = WTD_CHOICE_FILE;
        data.Anonymous.pFile = &mut file;
        data.dwStateAction = WTD_STATEACTION_VERIFY;
        data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_DISABLE_MD2_MD4;
        let no_window = INVALID_HANDLE_VALUE as HWND;
        let r = WinVerifyTrust(no_window, &mut action, &mut data as *mut _ as *mut _);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(no_window, &mut action, &mut data as *mut _ as *mut _);
        match r {
            0 => "valid",
            TRUST_E_NOSIGNATURE | TRUST_E_SUBJECT_FORM_UNKNOWN | TRUST_E_PROVIDER_UNKNOWN => "unsigned",
            CERT_E_UNTRUSTEDROOT | CERT_E_CHAINING | TRUST_E_SUBJECT_NOT_TRUSTED => "untrusted",
            TRUST_E_BAD_DIGEST => "invalid",
            _ => "invalid",
        }
    }
}

/// The signing certificate's display name and SHA-1 thumbprint.
#[cfg(windows)]
fn certificate(path: &Path) -> Option<(Option<String>, Option<String>)> {
    use windows_sys::Win32::Security::Cryptography::*;
    let w = wide(path);
    unsafe {
        let (mut store, mut msg): (HCERTSTORE, *mut core::ffi::c_void) = (std::ptr::null_mut(), std::ptr::null_mut());
        let (mut enc, mut content, mut format) = (0u32, 0u32, 0u32);
        let ok = CryptQueryObject(CERT_QUERY_OBJECT_FILE, w.as_ptr() as *const _, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_FORMAT_FLAG_BINARY, 0, &mut enc, &mut content, &mut format, &mut store, &mut msg, std::ptr::null_mut());
        if ok == 0 {
            return None;
        }
        let mut size = 0u32;
        let mut out = None;
        if CryptMsgGetParam(msg, CMSG_SIGNER_CERT_INFO_PARAM, 0, std::ptr::null_mut(), &mut size) != 0 {
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            if CryptMsgGetParam(msg, CMSG_SIGNER_CERT_INFO_PARAM, 0, buf.as_mut_ptr() as *mut _, &mut size) != 0 {
                let cert = CertFindCertificateInStore(store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0, CERT_FIND_SUBJECT_CERT, buf.as_ptr() as *const _, std::ptr::null());
                if !cert.is_null() {
                    let mut name = [0u16; 512];
                    let n = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, std::ptr::null(), name.as_mut_ptr(), name.len() as u32);
                    let subject = (n > 1).then(|| String::from_utf16_lossy(&name[..n as usize - 1]));
                    let mut hash = [0u8; 20];
                    let mut hn = hash.len() as u32;
                    let thumb = (CertGetCertificateContextProperty(cert, CERT_SHA1_HASH_PROP_ID, hash.as_mut_ptr() as *mut _, &mut hn) != 0).then(|| hex::encode(&hash[..hn as usize]));
                    out = Some((subject, thumb));
                    CertFreeCertificateContext(cert);
                }
            }
        }
        CryptMsgClose(msg);
        CertCloseStore(store, 0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn a_file_with_no_signature() {
        let p = std::env::temp_dir().join(format!("gwb-unsigned-{}.dll", crate::util::random_hex(4)));
        std::fs::write(&p, b"MZ not really").unwrap();
        let s = signer_of(&p);
        assert_eq!(s.status, "unsigned", "{s:?}");
        assert!(s.subject.is_none() && s.thumbprint.is_none());
        std::fs::remove_file(&p).ok();
    }

    /// A file of Windows itself, signed in place by Microsoft. Which files carry an embedded
    /// signature changes between releases, so the first one that has one decides.
    #[cfg(windows)]
    #[test]
    fn a_file_signed_by_a_trusted_root() {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let found = ["explorer.exe", "System32\\ntdll.dll", "System32\\wintrust.dll", "System32\\msvcp_win.dll", "System32\\mspaint.exe", "System32\\OneDriveSetup.exe"].iter().map(|f| signer_of(&Path::new(&root).join(f))).find(|s| s.subject.is_some());
        let Some(s) = found else { return };
        assert_eq!(s.status, "valid", "{s:?}");
        assert!(s.subject.as_deref().unwrap().contains("Microsoft"), "{s:?}");
        assert_eq!(s.thumbprint.as_deref().unwrap().len(), 40);
    }

    #[cfg(not(windows))]
    #[test]
    fn linux_says_it_did_not_check() {
        assert_eq!(signer_of(Path::new("/bin/sh")).status, "unchecked");
    }
}
