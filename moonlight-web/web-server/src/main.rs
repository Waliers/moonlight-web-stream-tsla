// Windows GUI subsystem: prevents Windows Terminal from owning our console window.
// We allocate our own console in main() so we have full control to hide/show it.
#![cfg_attr(windows, windows_subsystem = "windows")]

use common::config::Config;
use openssl::ssl::{SslAcceptor, SslFiletype, SslMethod};
use std::{io::ErrorKind, path::Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::{
    fs,
    io::{AsyncBufReadExt, BufReader, stdin},
};

use actix_web::{
    App, HttpServer,
    middleware::DefaultHeaders,
    web::Data,
};
use log::{LevelFilter, info, warn};
use serde::{Serialize, de::DeserializeOwned};
use simplelog::{ColorChoice, TermLogger, TerminalMode};

use crate::{
    acme::{acme_challenge_service, acme_api_service, new_challenge_store},
    api::{api_service, auth::ApiCredentials},
    data::{ApiData, RuntimeApiData},
    paths::validate_runtime_layout,
    web::{web_config_js_service, web_service},
};

mod acme;
mod api;
mod data;
mod paths;
#[cfg(windows)]
mod tray;
mod web;

#[actix_web::main]
async fn main() {
    // Allocate our own console window so we have full control (hide/show from tray).
    // Because we use windows_subsystem = "windows", no console exists by default.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, SetConsoleTitleW};
        use windows::core::w;
        let _ = AllocConsole();
        let _ = SetConsoleTitleW(w!("Moonlight Web Tesla"));
    }

    // Set working directory to the exe's folder so relative paths (./server/config.json) work
    // regardless of how the process was launched (e.g. from Start with Windows / registry).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::env::set_current_dir(dir);
        }
    }

    // If --minimized flag is passed (or "Start minimized" is enabled), hide console immediately
    #[cfg(windows)]
    let start_minimized = std::env::args().any(|a| a == "--minimized") || tray::is_start_minimized();
    #[cfg(windows)]
    if start_minimized {
        tray::hide_console();
    }

    #[cfg(debug_assertions)]
    let log_level = LevelFilter::Debug;
    #[cfg(not(debug_assertions))]
    let log_level = LevelFilter::Info;

    TermLogger::init(
        log_level,
        simplelog::Config::default(),
        TerminalMode::Mixed,
        ColorChoice::Auto,
    )
    .expect("failed to init logger");

    // Launch system tray (Windows only)
    #[cfg(windows)]
    let exit_signal = {
        let signal = Arc::new(AtomicBool::new(false));
        tray::spawn_tray(signal.clone());
        signal
    };
    #[cfg(not(windows))]
    let exit_signal = Arc::new(AtomicBool::new(false));

    if let Err(err) = main2().await {
        info!("Error: {err:?}");
    }

    if !exit_signal.load(Ordering::Relaxed) {
        exit().await.expect("exit failed")
    }
}

async fn exit() -> Result<(), anyhow::Error> {
    info!("Press Enter to close this window");

    let mut line = String::new();
    let mut reader = BufReader::new(stdin());

    reader.read_line(&mut line).await?;

    Ok(())
}

async fn main2() -> Result<(), anyhow::Error> {
    // Load Config
    const CONFIG_PATH: &str = "./server/config.json";
    let config = read_or_default::<Config>(CONFIG_PATH).await?;
    if config.credentials.as_deref() == Some("default") {
        info!("Enter your credentials in the config (server/config.json)");

        return Ok(());
    }

    // Validate config — warnings are logged, errors abort startup
    let (warnings, errors) = config.validate();
    for w in &warnings {
        warn!("{}", w);
    }
    if !errors.is_empty() {
        anyhow::bail!(
            "Config validation failed (server/config.json):\n  • {}",
            errors.join("\n  • ")
        );
    }
    validate_runtime_layout(&config)?;

    let creds = ApiCredentials::new(
        config.credentials.clone(),
        config.totp_secret.clone(),
        CONFIG_PATH.to_string(),
    );
    creds.load_sessions().await;
    let credentials = Data::new(creds);

    let config = Data::new(config);

    // Tell the tray the server URL so "Open Web UI" / "Copy URL" work
    #[cfg(windows)]
    {
        let url = if let Some(ext) = config.external_url.as_deref() {
            ext.to_string()
        } else {
            let (scheme, addr) = if let Some(https_addr) = config.bind_address_https {
                ("https", https_addr)
            } else if config.certificate.is_some() {
                ("https", config.bind_address)
            } else {
                ("http", config.bind_address)
            };
            // Use the configured IP (not localhost) so it works on LAN
            format!("{scheme}://{addr}")
        };
        tray::set_server_url(url);
    }

    // Load Data
    let data = read_or_default::<ApiData>(&config.data_path).await?;
    let data = RuntimeApiData::load(&config, data).await;

    let bind_address = config.bind_address;
    let bind_address_https = config.bind_address_https;
    let acme_store = Data::new(new_challenge_store());
    let server = HttpServer::new({
        let config = config.clone();
        let acme_store = acme_store.clone();

        move || {
            App::new()
                .wrap(
                    DefaultHeaders::new()
                        .add(("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"))
                        .add(("Pragma", "no-cache"))
                        .add(("Expires", "0")),
                )
                .app_data(config.clone())
                .app_data(credentials.clone())
                .app_data(acme_store.clone())
                .service(acme_challenge_service())
                .service(acme_api_service())
                .service(api_service(data.clone()))
                .service(web_config_js_service())
                .service(web_service())
        }
    })
    // Default is one worker per logical CPU — far more than a single-user
    // server needs on a box that also runs the game, encoder, and streamer.
    .workers(2);

    if let Some(certificate) = config.certificate.as_ref() {
        let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls())
            .map_err(|e| anyhow::anyhow!("failed to create SSL/TLS acceptor: {e}"))?;
        // Restrict ALPN to HTTP/1.1 only — actix-ws WebSocket upgrades require HTTP/1.1
        // and will break if the browser negotiates HTTP/2 (which mozilla_intermediate advertises).
        builder
            .set_alpn_protos(b"\x08http/1.1")
            .map_err(|e| anyhow::anyhow!("failed to set ALPN protos: {e}"))?;
        builder
            .set_private_key_file(&certificate.private_key_pem, SslFiletype::PEM)
            .map_err(|e| anyhow::anyhow!("failed to load SSL private key '{}': {e}", certificate.private_key_pem))?;
        builder
            .set_certificate_chain_file(&certificate.certificate_pem)
            .map_err(|e| anyhow::anyhow!("failed to load SSL certificate '{}': {e}", certificate.certificate_pem))?;

        if let Some(https_addr) = bind_address_https {
            // Dual binding: plain HTTP on bind_address, HTTPS on bind_address_https
            info!("[Server]: Running dual-bind — HTTP on {bind_address}, HTTPS on {https_addr}");
            server
                .bind(bind_address)?
                .bind_openssl(https_addr, builder)?
                .run()
                .await?;
        } else {
            // Single binding: HTTPS only on bind_address
            info!("[Server]: Running Https Server with ssl tls");
            server.bind_openssl(bind_address, builder)?.run().await?;
        }
    } else {
        server.bind(bind_address)?.run().await?;
    }

    Ok(())
}

/// Drops commas that appear (outside string literals) immediately before a
/// `}` or `]`, ignoring intervening whitespace. Hand-edited config files
/// commonly pick up a trailing comma when a list entry gets added or
/// removed — plain JSON rejects that, so tolerate it here rather than fail
/// startup over one extra character. Not a general JSON5 parser: this is
/// the one specific, well-understood leniency, nothing else (no comments,
/// no unquoted keys, no single quotes).
fn strip_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }

        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }

        if c == ',' {
            let mut lookahead = chars.clone();
            let mut is_trailing = false;
            while let Some(&next) = lookahead.peek() {
                if next.is_whitespace() {
                    lookahead.next();
                } else {
                    is_trailing = next == '}' || next == ']';
                    break;
                }
            }
            if is_trailing {
                continue; // drop this comma
            }
        }

        out.push(c);
    }

    out
}

#[cfg(test)]
mod config_parsing_tests {
    use super::strip_trailing_commas;

    #[test]
    fn drops_trailing_comma_in_object() {
        assert_eq!(strip_trailing_commas(r#"{"a": 1,}"#), r#"{"a": 1}"#);
    }

    #[test]
    fn drops_trailing_comma_in_array() {
        assert_eq!(strip_trailing_commas(r#"[1, 2,]"#), r#"[1, 2]"#);
    }

    #[test]
    fn drops_trailing_comma_across_whitespace_and_newlines() {
        let input = "[\n    1,\n    2,\n]";
        let expected = "[\n    1,\n    2\n]";
        assert_eq!(strip_trailing_commas(input), expected);
    }

    #[test]
    fn drops_nested_trailing_commas() {
        assert_eq!(
            strip_trailing_commas(r#"{"a": [1, 2,], "b": {"c": 3,},}"#),
            r#"{"a": [1, 2], "b": {"c": 3}}"#
        );
    }

    #[test]
    fn leaves_non_trailing_commas_alone() {
        assert_eq!(strip_trailing_commas(r#"{"a": 1, "b": 2}"#), r#"{"a": 1, "b": 2}"#);
    }

    #[test]
    fn ignores_comma_like_patterns_inside_strings() {
        // A string ending in ", }" must not be treated as a trailing comma —
        // only unquoted structural commas are ever candidates.
        let input = r#"{"a": "value, }", "b": 2}"#;
        assert_eq!(strip_trailing_commas(input), input);
    }

    #[test]
    fn handles_escaped_quotes_inside_strings() {
        // The escaped quote must not end the string early, or the comma
        // right after it would be misread as structural.
        let input = r#"{"a": "she said \"hi,\"", "b": 2,}"#;
        let expected = r#"{"a": "she said \"hi,\"", "b": 2}"#;
        assert_eq!(strip_trailing_commas(input), expected);
    }

    #[test]
    fn no_trailing_comma_is_a_no_op() {
        let input = r#"{"a": [1, 2], "b": {"c": 3}}"#;
        assert_eq!(strip_trailing_commas(input), input);
    }
}

async fn read_or_default<T>(path: impl AsRef<Path>) -> Result<T, anyhow::Error>
where
    T: DeserializeOwned + Serialize + Default,
{
    match fs::read_to_string(path.as_ref()).await {
        Ok(value) => {
            // Windows editors (Notepad, some PowerShell cmdlets) commonly save
            // UTF-8 files with a leading BOM. It isn't valid JSON whitespace, so
            // serde_json rejects an otherwise-correct file with a confusing
            // "expected value at line 1 column 1" — strip it before parsing.
            let value = value.strip_prefix('\u{FEFF}').unwrap_or(&value).to_string();
            let value = strip_trailing_commas(&value);
            serde_json::from_str(&value).map_err(|err| {
                // serde_json gives 1-based line/column — extract the offending line for context
                let line_no = err.line();
                let col_no  = err.column();
                let src_line = value
                    .lines()
                    .nth(line_no.saturating_sub(1))
                    .unwrap_or("");
                let caret = " ".repeat(col_no.saturating_sub(1)) + "^";
                anyhow::anyhow!(
                    "'{}' contains invalid JSON at line {}, column {}:\n\n  {}\n  {}\n\n{}\n\nFix the file and restart.",
                    path.as_ref().display(),
                    line_no,
                    col_no,
                    src_line,
                    caret,
                    err,
                )
            })
        },
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let value = T::default();

            let value_str = serde_json::to_string_pretty(&value)
                .map_err(|e| anyhow::anyhow!("failed to serialize default for '{}': {e}", path.as_ref().display()))?;

            if let Some(parent) = path.as_ref().parent() {
                fs::create_dir_all(parent)
                    .await
                    .map_err(|e| anyhow::anyhow!("failed to create directories for '{}': {e}", path.as_ref().display()))?;
            }
            fs::write(path.as_ref(), value_str)
                .await
                .map_err(|e| anyhow::anyhow!("failed to write default file '{}': {e}", path.as_ref().display()))?;

            Ok(value)
        }
        Err(err) => Err(anyhow::anyhow!("failed to read '{}': {}", path.as_ref().display(), err)),
    }
}
