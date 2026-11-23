//! Loading the server's certificate and key into a rustls configuration (AC-5).

use std::path::Path;
use std::sync::Arc;

use rustls::ServerConfig;
use rustls::crypto::ring;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

use crate::certs::ConfigError;

/// Reads the PEM files and builds a TLS 1.2/1.3 configuration with the ring provider, no client
/// authentication and ALPN `http/1.1` only.
///
/// # Errors
/// A file that is missing, unreadable or not PEM, or a key that does not belong to the certificate.
/// The message names the file and never holds key material.
pub fn load_config(cert: &Path, key: &Path) -> Result<Arc<ServerConfig>, ConfigError> {
    let chain = CertificateDer::pem_file_iter(cert)
        .map_err(|e| ConfigError(format!("{}: {e}", cert.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| ConfigError(format!("{}: {e}", cert.display())))?;
    if chain.is_empty() {
        return Err(ConfigError(format!(
            "{}: no certificate found",
            cert.display()
        )));
    }
    let key_der = PrivateKeyDer::from_pem_file(key)
        .map_err(|e| ConfigError(format!("{}: {e}", key.display())))?;
    let mut config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| ConfigError(format!("TLS versions: {e}")))?
        .with_no_client_auth()
        .with_single_cert(chain, key_der)
        .map_err(|e| ConfigError(format!("{} and {}: {e}", cert.display(), key.display())))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::certs::write_set;

    #[test]
    fn loads_a_generated_set() {
        let d = tempfile::tempdir().unwrap();
        write_set(d.path(), &["localhost".into()], 1, false).unwrap();
        let c = load_config(&d.path().join("server.pem"), &d.path().join("server.key")).unwrap();
        assert_eq!(c.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn missing_garbage_and_mismatched_files_are_configuration_errors() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write_set(a.path(), &["localhost".into()], 1, false).unwrap();
        write_set(b.path(), &["localhost".into()], 1, false).unwrap();
        let cert = a.path().join("server.pem");
        let e = load_config(&cert, &a.path().join("nope.key")).unwrap_err();
        assert!(e.to_string().contains("nope.key"));
        std::fs::write(a.path().join("junk"), "not pem").unwrap();
        assert!(load_config(&a.path().join("junk"), &a.path().join("server.key")).is_err());
        assert!(load_config(&cert, &a.path().join("junk")).is_err());
        let e = load_config(&cert, &b.path().join("server.key")).unwrap_err();
        assert!(!e.to_string().contains("PRIVATE KEY"));
    }
}
