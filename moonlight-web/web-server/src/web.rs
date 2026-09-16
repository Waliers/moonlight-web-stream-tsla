use actix_files::Files;
use actix_web::{
    Error, HttpResponse,
    body::MessageBody,
    dev::{HttpServiceFactory, ServiceRequest, ServiceResponse},
    get,
    http::header::{self, HeaderValue},
    middleware::{Next, from_fn},
    services,
    web,
    web::Data,
};
use common::{api_bindings::ConfigJs, config::Config};
use log::warn;

use crate::api::auth::ApiCredentials;
use crate::paths::web_asset_dir;

/// Per-request cache policy for static assets.
///
/// The build (buildAll.ps1) stamps a `?v=<content hash>` onto every asset
/// reference inside the HTML/JS/CSS, so:
/// - HTML (the entry points carrying those hashes) must always be fresh: no-store.
/// - Requests with a `v=` hash are immutable — a change produces a new URL —
///   and can be cached for a year. This is what saves re-downloading all the
///   JS + Opus WASM over LTE on every drive.
/// - Anything else (e.g. workers loaded via `new URL(...)` without a hash)
///   may be cached but must revalidate; combined with ETag/Last-Modified this
///   turns repeat downloads into 304s.
async fn static_cache_headers(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let is_versioned = req
        .query_string()
        .split('&')
        .any(|pair| pair.starts_with("v=") && pair.len() > 2);
    let file_name = req.path().rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    let is_html = file_name.ends_with(".html") || !file_name.contains('.');

    let mut res = next.call(req).await?;

    let cache_control = if is_html {
        "no-store, no-cache, must-revalidate, max-age=0"
    } else if is_versioned {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));

    Ok(res)
}

pub fn web_service() -> impl HttpServiceFactory {
    let files = Files::new("/", web_asset_dir()).index_file("index.html");

    web::scope("")
        .wrap(from_fn(static_cache_headers))
        .service(files.use_etag(true).use_last_modified(true))
}

pub fn web_config_js_service() -> impl HttpServiceFactory {
    services![config_js]
}
#[get("/config.js")]
async fn config_js(credentials: Data<ApiCredentials>, config: Data<Config>) -> HttpResponse {
    let config_json = match serde_json::to_string(&ConfigJs {
        enable_credential_authentication: credentials.enable_credential_authentication(),
        path_prefix: config.web_path_prefix.clone(),
    }) {
        Ok(value) => value,
        Err(err) => {
            warn!(
                "failed to create the web config.js. The Web Interface might fail to load! {err:?}"
            );

            return HttpResponse::InternalServerError().finish();
        }
    };
    let config_js = format!("export default {config_json}");

    HttpResponse::Ok()
        .append_header(("Content-Type", "text/javascript"))
        .body(config_js)
}
