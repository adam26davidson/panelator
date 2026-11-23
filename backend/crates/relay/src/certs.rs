//! Certificates for a rig (AC-15): a new CA, a server certificate it signs, both ECDSA P-256.

use std::fmt;
use std::fs;
use std::io::Write;
use std::net::IpAddr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256, SanType,
};

/// A configuration or file error: the process exits with status 2 and prints this.
#[derive(Debug)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// The PEM text of a generated rig certificate set.
#[derive(Debug)]
pub struct CertSet {
    /// The CA certificate.
    pub ca_pem: String,
    /// The server certificate.
    pub server_pem: String,
    /// The server's private key.
    pub server_key_pem: String,
}

fn valid_dns_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.trim_end_matches('.').split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

fn err(what: &str, e: impl fmt::Display) -> ConfigError {
    ConfigError(format!("{what}: {e}"))
}

/// Makes a CA and a server certificate for `sans`, valid from now for `days`. The CA's private key
/// is dropped before this returns.
///
/// # Errors
/// A SAN that is neither an IP address nor a valid DNS name, or a failure of the crypto library.
pub fn generate(sans: &[String], days: u32) -> Result<CertSet, ConfigError> {
    let mut san_types = Vec::new();
    for s in sans {
        if let Ok(ip) = s.parse::<IpAddr>() {
            san_types.push(SanType::IpAddress(ip));
        } else if valid_dns_name(s) {
            san_types.push(SanType::DnsName(
                s.clone().try_into().map_err(|e| err(s, e))?,
            ));
        } else {
            return Err(ConfigError(format!(
                "--san {s}: not an IP address or a valid DNS name"
            )));
        }
    }
    if san_types.is_empty() {
        return Err(ConfigError(
            "--san: at least one name or address is needed".into(),
        ));
    }
    let now = time::OffsetDateTime::now_utc();
    let dn = |cn: &str| {
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, cn);
        dn
    };

    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| err("CA key", e))?;
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).map_err(|e| err("CA", e))?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    ca_params.distinguished_name = dn("panelator relay stub CA");
    ca_params.not_before = now;
    ca_params.not_after = now + time::Duration::days(i64::from(days));
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|e| err("CA certificate", e))?;

    let server_key =
        KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| err("server key", e))?;
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(|e| err("server", e))?;
    params.subject_alt_names = san_types;
    params.is_ca = IsCa::ExplicitNoCa;
    params.use_authority_key_identifier_extension = true;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.distinguished_name = dn("panelator relay stub");
    params.not_before = now;
    params.not_after = now + time::Duration::days(i64::from(days));
    let issuer = Issuer::new(ca_params, ca_key);
    let server_cert = params
        .signed_by(&server_key, &issuer)
        .map_err(|e| err("server certificate", e))?;
    Ok(CertSet {
        ca_pem: ca_cert.pem(),
        server_pem: server_cert.pem(),
        server_key_pem: server_key.serialize_pem(),
    })
}

/// Generates the set and writes `ca.pem`, `server.pem` and `server.key` (mode 0600) into `dir`.
/// Nothing is written when one of them exists, unless `force`. Returns the three paths.
///
/// # Errors
/// An invalid SAN, an existing file without `force`, or an I/O failure.
pub fn write_set(
    dir: &Path,
    sans: &[String],
    days: u32,
    force: bool,
) -> Result<[PathBuf; 3], ConfigError> {
    let paths = ["ca.pem", "server.pem", "server.key"].map(|n| dir.join(n));
    if !force && let Some(p) = paths.iter().find(|p| p.symlink_metadata().is_ok()) {
        return Err(ConfigError(format!(
            "{} exists; use --force to replace it",
            p.display()
        )));
    }
    let set = generate(sans, days)?;
    fs::create_dir_all(dir).map_err(|e| err(&dir.display().to_string(), e))?;
    let contents = [
        (&set.ca_pem, 0o644),
        (&set.server_pem, 0o644),
        (&set.server_key_pem, 0o600),
    ];
    for (path, (text, mode)) in paths.iter().zip(contents) {
        if force {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(err(&path.display().to_string(), e)),
            }
        }
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(path)
            .map_err(|e| err(&path.display().to_string(), e))?;
        f.write_all(text.as_bytes())
            .map_err(|e| err(&path.display().to_string(), e))?;
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use x509_parser::prelude::*;

    fn sans() -> Vec<String> {
        vec!["rig.local".into(), "192.168.1.5".into()]
    }

    #[test]
    fn writes_three_files_with_a_private_key() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("certs");
        write_set(&out, &sans(), 30, false).unwrap();
        let mode = fs::metadata(out.join("server.key"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let ca = fs::read_to_string(out.join("ca.pem")).unwrap();
        let server = fs::read_to_string(out.join("server.pem")).unwrap();
        assert!(!server.contains("PRIVATE KEY") && !ca.contains("PRIVATE KEY"));
        let (_, ca_pem) = parse_x509_pem(ca.as_bytes()).unwrap();
        let ca_cert = ca_pem.parse_x509().unwrap();
        let (_, sv_pem) = parse_x509_pem(server.as_bytes()).unwrap();
        let sv = sv_pem.parse_x509().unwrap();
        assert!(ca_cert.is_ca());
        assert!(sv.verify_signature(Some(ca_cert.public_key())).is_ok());
        let san = sv.subject_alternative_name().unwrap().unwrap();
        let names = &san.value.general_names;
        assert_eq!(names.len(), 2);
        assert!(
            names
                .iter()
                .any(|n| matches!(n, GeneralName::DNSName("rig.local")))
        );
        assert!(
            names
                .iter()
                .any(|n| matches!(n, GeneralName::IPAddress(b) if *b == [192, 168, 1, 5]))
        );
        for cert in [&ca_cert, &sv] {
            assert_eq!(
                cert.public_key().algorithm.algorithm.to_id_string(),
                "1.2.840.10045.2.1"
            );
            assert_eq!(
                cert.public_key()
                    .algorithm
                    .parameters
                    .as_ref()
                    .unwrap()
                    .as_oid()
                    .unwrap()
                    .to_id_string(),
                "1.2.840.10045.3.1.7",
                "both keys must use the P-256 curve"
            );
        }
        let key = fs::read_to_string(out.join("server.key")).unwrap();
        assert!(key.contains("PRIVATE KEY"));
        let days =
            (sv.validity().not_after.timestamp() - sv.validity().not_before.timestamp()) / 86400;
        assert_eq!(days, 30);
    }

    #[test]
    fn an_existing_file_stops_a_second_run_unless_forced() {
        let dir = tempfile::tempdir().unwrap();
        write_set(dir.path(), &sans(), 30, false).unwrap();
        let before: Vec<_> = ["ca.pem", "server.pem", "server.key"]
            .iter()
            .map(|n| fs::read(dir.path().join(n)).unwrap())
            .collect();
        assert!(write_set(dir.path(), &sans(), 30, false).is_err());
        let after: Vec<_> = ["ca.pem", "server.pem", "server.key"]
            .iter()
            .map(|n| fs::read(dir.path().join(n)).unwrap())
            .collect();
        assert_eq!(before, after);
        write_set(dir.path(), &sans(), 30, true).unwrap();
        let again: Vec<_> = ["ca.pem", "server.pem", "server.key"]
            .iter()
            .map(|n| fs::read(dir.path().join(n)).unwrap())
            .collect();
        assert!(before.iter().zip(&again).all(|(a, b)| a != b));
        assert_eq!(
            fs::metadata(dir.path().join("server.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn a_bad_san_is_named() {
        let e = generate(&["not a name!".into()], 1).unwrap_err();
        assert!(e.to_string().contains("not a name!"));
    }
}
