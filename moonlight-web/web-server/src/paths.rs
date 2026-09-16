use std::path::PathBuf;

use common::config::Config;

pub fn web_asset_dir() -> &'static str {
    #[cfg(debug_assertions)]
    {
        "dist"
    }

    #[cfg(not(debug_assertions))]
    {
        "static"
    }
}

pub fn resolve_streamer_path(config: &Config) -> PathBuf {
    let configured = PathBuf::from(&config.streamer_path);

    #[cfg(windows)]
    {
        if configured.extension().is_none() && !configured.exists() {
            let candidate = configured.with_extension("exe");
            if candidate.exists() {
                return candidate;
            }
        }
    }

    configured
}

pub fn validate_runtime_layout(config: &Config) -> Result<(), anyhow::Error> {
    let asset_dir = PathBuf::from(web_asset_dir());
    if !asset_dir.is_dir() {
        anyhow::bail!(
            "Web asset directory '{}' was not found next to the executable. Build the frontend and package it as '{}'.",
            asset_dir.display(),
            web_asset_dir(),
        );
    }

    let streamer_path = resolve_streamer_path(config);
    if !streamer_path.is_file() {
        anyhow::bail!(
            "Streamer executable '{}' was not found. Update server/config.json -> streamer_path or package streamer next to web-server.",
            streamer_path.display(),
        );
    }

    Ok(())
}
