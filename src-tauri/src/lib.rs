//! REALM desktop（Tauri 2）Rust bootstrap/runtime controller。
//!
//! 职责边界：
//! - spawn `node launcher/realm-service-host.mjs`，解析 JSON-lines 协议，
//!   维护桌面启动状态机（Idle→Starting(step)→Ready/Failed→Stopping→Stopped）；
//! - 命令：service_start / service_stop / service_state / open_in_browser /
//!   validate_server_url / validate_advertised_origin / validate_lan_bind /
//!   host_kind；
//! - 窗口关闭 = 先 SIGTERM 子进程并等待优雅停止（锁/PG 不被遗留）；
//! - 不透传任何敏感环境变量；REALM_ACCESS_TOKEN 已随账户登录退役，
//!   任何模式（含显式 LAN bind）都不再向子 launcher 传递令牌。
//!
//! Android：host_kind() = "android" 时 UI 进入 client-only 配置流；
//! service_start 在本平台不可用（APK 不捆绑服务端/Node/PostgreSQL）。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum ServicePhase {
    Idle,
    Starting { step: String },
    Ready { url: String, advertised_origin: Option<String> },
    Failed { kind: String, message: String },
    Stopping,
    Stopped,
}

#[derive(Default)]
pub struct ServiceState {
    phase: Option<ServicePhase>,
    child: Option<Child>,
}

impl ServiceState {
    fn phase(&self) -> ServicePhase {
        self.phase.clone().unwrap_or(ServicePhase::Idle)
    }
}

type Shared = Arc<Mutex<ServiceState>>;

fn set_phase(shared: &Shared, app: Option<&AppHandle>, phase: ServicePhase) {
    {
        let mut guard = shared.lock().expect("service state poisoned");
        guard.phase = Some(phase.clone());
    }
    if let Some(app) = app {
        let _ = app.emit("service-state", phase);
    }
}

// ---------------------------------------------------------------------------
// server origin 校验（桌面 open_in_browser 与 Android 配置共用同一规则）
// ---------------------------------------------------------------------------

/// 规则：仅 http/https；host 非空；禁止 userinfo（用户名/密码/token 内嵌）；
/// 禁止 query/fragment；file:/tauri: 等 scheme 一律拒绝。
/// 通过则返回规范化 origin（scheme://host[:port][/path，无尾斜杠]）。
pub fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty url".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme: {other}")),
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("missing host".into());
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("credentials in url are not allowed".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("query/fragment are not allowed".into());
    }
    let path = parsed.path().trim_end_matches('/');
    let mut origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    if !path.is_empty() && path != "/" {
        origin.push_str(path);
    }
    Ok(origin)
}

/// advertised origin 校验（与 launcher/advertised-origin.mjs 同规则）：
/// 显式值必须是纯 origin——http/https、host 非空、无 userinfo/路径/query/
/// fragment。错误消息不回显原值（可能内嵌凭据）。
pub fn normalize_advertised_origin(input: &str) -> Result<String, String> {
    let parsed = normalize_server_url(input)?;
    // normalize_server_url 允许路径；advertised origin 必须是纯 origin。
    let reparsed = url::Url::parse(&parsed).map_err(|_| "invalid url".to_string())?;
    if reparsed.path() != "/" && !reparsed.path().is_empty() {
        return Err("advertised origin must not contain a path".into());
    }
    Ok(parsed)
}

/// LAN bind 校验：必须是显式 IPv4；0.0.0.0 允许作为明确的全接口选择，
/// 但不会被当作可分享 origin 自动推导。
pub fn normalize_lan_bind(input: &str) -> Result<String, String> {
    let bind = input.trim();
    if bind == "0.0.0.0" {
        return Ok(bind.into());
    }
    let octets = bind.split('.').collect::<Vec<_>>();
    if octets.len() != 4
        || octets.iter().any(|octet| {
            octet.is_empty()
                || octet.len() > 3
                || !octet.bytes().all(|byte| byte.is_ascii_digit())
                || octet.parse::<u8>().is_err()
        })
    {
        return Err("LAN bind must be an explicit IPv4 address".into());
    }
    Ok(bind.into())
}

// ---------------------------------------------------------------------------
// host 协议帧 → 状态迁移（纯函数，便于单测）
// ---------------------------------------------------------------------------

fn apply_frame(current: &ServicePhase, frame: &serde_json::Value) -> Option<ServicePhase> {
    let frame_type = frame.get("type")?.as_str()?;
    match frame_type {
        "step" => {
            // ready 之后不再回退到 starting（幂等步骤事件）。
            if matches!(current, ServicePhase::Ready { .. } | ServicePhase::Stopping) {
                return None;
            }
            let step = frame.get("step")?.as_str()?.to_string();
            Some(ServicePhase::Starting { step })
        }
        "ready" => Some(ServicePhase::Ready {
            url: frame.get("url")?.as_str()?.to_string(),
            advertised_origin: frame
                .get("advertisedOrigin")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        }),
        "error" => Some(ServicePhase::Failed {
            kind: frame
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("failed")
                .to_string(),
            message: frame
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("service failed")
                .to_string(),
        }),
        "stopping" => Some(ServicePhase::Stopping),
        "stopped" => Some(ServicePhase::Stopped),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 进程编排
// ---------------------------------------------------------------------------

fn resource_realm_home_from_dir(resource_dir: &Path) -> Option<PathBuf> {
    let candidate = resource_dir.join("realm");
    candidate
        .join("launcher/realm-service-host.mjs")
        .exists()
        .then_some(candidate)
}

fn resource_realm_home(app: &AppHandle) -> Option<PathBuf> {
    resource_realm_home_from_dir(&app.path().resource_dir().ok()?)
}

fn realm_home(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("REALM_HOME") {
        let candidate = PathBuf::from(explicit);
        if candidate.join("launcher/realm-service-host.mjs").exists() {
            return Ok(candidate);
        }
        return Err(format!(
            "REALM_HOME does not contain launcher/realm-service-host.mjs: {}",
            candidate.display()
        ));
    }
    if let Some(resource) = resource_realm_home(app) {
        return Ok(resource);
    }
    // 开发模式：src-tauri 的上一级即仓库根。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if dev.join("launcher/realm-service-host.mjs").exists() {
        return Ok(dev);
    }
    Err("could not locate the REALM app directory".into())
}

fn bundled_node(home: &Path) -> PathBuf {
    let candidates = if cfg!(target_os = "windows") {
        vec![home.join("runtime/node/win-x64/node.exe")]
    } else if cfg!(target_os = "macos") {
        vec![
            home.join("runtime/node/darwin-arm64/bin/node"),
            home.join("runtime/node/darwin-x64/bin/node"),
        ]
    } else {
        vec![home.join("runtime/node/linux-x64/bin/node")]
    };
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .or_else(|| std::env::var_os("REALM_NODE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn host_environment() -> Vec<(String, String)> {
    const SAFE_KEYS: &[&str] = &[
        "PATH",
        "Path",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ComSpec",
        "COMSPEC",
        "PATHEXT",
        "SystemDrive",
        "OS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "NUMBER_OF_PROCESSORS",
        "NODE_ENV",
        "LANG",
        "LC_ALL",
        "TZ",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "REALM_DATA_HOME",
        "REALM_POSTGRES_BIN",
        "REALM_POSTGRES_DATA_DIR",
        "REALM_POSTGRES_LOG",
        "REALM_POSTGRES_SOCKET_DIR",
        "REALM_POSTGRES_DB",
    ];
    let mut environment = SAFE_KEYS
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| ((*key).into(), value)))
        .collect::<Vec<_>>();
    // REALM_ACCESS_TOKEN 已退役（账户名+可选密码登录）：任何模式都不向
    // 子进程传递令牌；LAN 不再需要令牌前置。
    environment
}

fn spawn_host(
    app: &AppHandle,
    shared: &Shared,
    advertised_origin: Option<&str>,
    lan_bind: Option<&str>,
) -> Result<(), String> {
    {
        let guard = shared.lock().expect("service state poisoned");
        if guard.child.is_some() {
            return Err("service is already running or starting".into());
        }
    }
    let home = realm_home(app)?;
    let node = bundled_node(&home);
    let mut command = Command::new(node);
    command
        .arg(home.join("launcher/realm-service-host.mjs"))
        .arg("--home")
        .arg(&home);
    if let Some(origin) = advertised_origin {
        command.arg("--advertised-origin").arg(origin);
    }
    if let Some(bind) = lan_bind {
        command.arg("--lan").arg(bind);
    }
    command
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // 诊断输出进 launcher.log（host 自身行为）；stderr 不混入协议帧。
        .stderr(Stdio::null())
        .env_clear()
        .envs(host_environment());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn service host: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "host stdout unavailable".to_string())?;
    {
        let mut guard = shared.lock().expect("service state poisoned");
        guard.child = Some(child);
    }
    set_phase(shared, Some(app), ServicePhase::Starting {
        step: "spawn".into(),
    });

    let thread_shared = Arc::clone(shared);
    let thread_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let frame: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                // 非协议行不进入状态机（也不含敏感值——host 协议保证）。
                Err(_) => continue,
            };
            let next = {
                let guard = thread_shared.lock().expect("service state poisoned");
                apply_frame(&guard.phase(), &frame)
            };
            if let Some(phase) = next {
                set_phase(&thread_shared, Some(&thread_app), phase);
            }
        }
        // stdout 关闭 = 进程已退出；若仍停在 Starting/Ready 视为异常终止。
        let mut guard = thread_shared.lock().expect("service state poisoned");
        if let Some(mut child) = guard.child.take() {
            let _ = child.wait();
        }
        match guard.phase() {
            ServicePhase::Starting { .. } | ServicePhase::Ready { .. } => {
                drop(guard);
                set_phase(
                    &thread_shared,
                    Some(&thread_app),
                    ServicePhase::Failed {
                        kind: "exited".into(),
                        message: "service host exited unexpectedly".into(),
                    },
                );
            }
            ServicePhase::Stopping => {
                drop(guard);
                set_phase(&thread_shared, Some(&thread_app), ServicePhase::Stopped);
            }
            _ => {}
        }
    });
    Ok(())
}

fn signal_stop(shared: &Shared) {
    let mut guard = shared.lock().expect("service state poisoned");
    if let Some(child) = guard.child.as_mut() {
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        {
            // Windows 无 SIGTERM；Node 无法捕获 SIGKILL，launcher 锁按
            // stale 回收（acquireLock 已有该语义）。
            let _ = child.kill();
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn host_kind() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

#[tauri::command]
fn service_state(state: State<'_, Shared>) -> ServicePhase {
    state.lock().expect("service state poisoned").phase()
}

#[tauri::command]
fn service_start(
    app: AppHandle,
    state: State<'_, Shared>,
    advertised_origin: Option<String>,
    lan_bind: Option<String>,
) -> Result<(), String> {
    if cfg!(target_os = "android") {
        return Err("service hosting is not available on Android".into());
    }
    // 参数校验先于任何 spawn/副作用。
    let validated = match advertised_origin {
        Some(raw) => Some(normalize_advertised_origin(raw.trim())?),
        None => None,
    };
    let validated_lan = match lan_bind {
        Some(raw) if !raw.trim().is_empty() => Some(normalize_lan_bind(&raw)?),
        _ => None,
    };
    let shared = state.inner().clone();
    spawn_host(
        &app,
        &shared,
        validated.as_deref(),
        validated_lan.as_deref(),
    )
}

#[tauri::command]
fn service_stop(state: State<'_, Shared>) -> Result<(), String> {
    let shared = state.inner().clone();
    {
        let guard = shared.lock().expect("service state poisoned");
        if guard.child.is_none() {
            return Ok(());
        }
    }
    set_phase(&shared, None, ServicePhase::Stopping);
    signal_stop(&shared);
    Ok(())
}

#[tauri::command]
fn validate_server_url(input: String) -> Result<String, String> {
    normalize_server_url(&input)
}

#[tauri::command]
fn validate_invite_url(input: String) -> Result<InviteTarget, String> {
    normalize_invite_url(&input)
}

#[tauri::command]
fn validate_advertised_origin(input: String) -> Result<String, String> {
    normalize_advertised_origin(&input)
}

#[tauri::command]
fn validate_lan_bind(input: String) -> Result<String, String> {
    normalize_lan_bind(&input)
}

/// 大厅邀请链接校验结果（严格白名单结构，serde 字段固定）。
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InviteTarget {
    server_url: String,
    lobby_room_id: Option<String>,
}

/// 邀请 URL 校验：`http(s)://host[:port]/?lobby=<roomId>` 是唯一合法形态。
/// 拒绝 userinfo/fragment/路径/未知或重复 query/非法 roomId；错误不回显
/// 原始输入（可能内嵌凭据）。服务根地址（无 query）合法且 lobby 为 None。
/// 绝不信任 Host/X-Forwarded-Host——只解析用户显式粘贴的字符串。
pub fn normalize_invite_url(input: &str) -> Result<InviteTarget, String> {
    let trimmed = input.trim();
    // 先用既有的 server URL 校验（scheme/host/userinfo）；邀请允许 query。
    // 不能复用 normalize_server_url 的 query 拒绝——query 需要白名单解析。
    let parsed = url::Url::parse(trimmed).map_err(|_| "invalid url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme: {other}")),
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("missing host".into());
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("credentials in url are not allowed".into());
    }
    if parsed.fragment().is_some() {
        return Err("fragment is not allowed".into());
    }
    let path = parsed.path();
    if !path.is_empty() && path != "/" {
        return Err("path is not allowed".into());
    }
    let mut lobby_room_id: Option<String> = None;
    for (key, value) in parsed.query_pairs() {
        if key != "lobby" {
            return Err("unknown query parameter".into());
        }
        if lobby_room_id.is_some() {
            return Err("duplicate lobby parameter".into());
        }
        let room_id = value.into_owned();
        let valid = room_id.len() == 30
            && room_id.starts_with("lobby_")
            && room_id[6..].chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase());
        if !valid {
            return Err("invalid lobby room id".into());
        }
        lobby_room_id = Some(room_id);
    }
    if parsed.query().is_some() && lobby_room_id.is_none() {
        return Err("query parameter must be lobby".into());
    }
    let mut origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(InviteTarget {
        server_url: origin,
        lobby_room_id,
    })
}

#[derive(Serialize)]
struct ServerCheck {
    status: u16,
}

#[tauri::command]
async fn check_server(url: String) -> Result<ServerCheck, String> {
    let normalized = normalize_server_url(&url)?;
    let endpoint = format!("{normalized}/");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("could not prepare connection check: {error}"))?;
    let response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|error| format!("connection check failed: {error}"))?;
    let status = response.status().as_u16();
    if status >= 500 {
        return Err(format!("service returned HTTP {status}"));
    }
    Ok(ServerCheck { status })
}

#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = normalize_server_url(&url)?;
        Err("open_in_browser is not available on Android".into())
    }

    #[cfg(not(target_os = "android"))]
    {
        let normalized = normalize_server_url(&url)?;
        // 仅打开通过校验的 http(s) URL；不经过 shell 字符串拼接。
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/c", "start", "", &normalized]);
            command
        };
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("open");
            command.arg(&normalized);
            command
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = {
            let mut command = Command::new("xdg-open");
            command.arg(&normalized);
            command
        };
        command
            .spawn()
            .map_err(|error| format!("failed to open the browser: {error}"))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 应用入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: Shared = Arc::new(Mutex::new(ServiceState::default()));
    let window_shared = Arc::clone(&shared);
    tauri::Builder::default()
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            host_kind,
            service_state,
            service_start,
            service_stop,
            validate_server_url,
            validate_invite_url,
            validate_advertised_origin,
            validate_lan_bind,
            check_server,
            open_in_browser,
        ])
        .on_window_event(move |_window, event| {
            if let WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed = event {
                // 关窗 = 优雅停止服务（SIGTERM 后短暂等待，锁/PG 不遗留）。
                signal_stop(&window_shared);
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    {
                        let mut guard = window_shared.lock().expect("service state poisoned");
                        if let Some(child) = guard.child.as_mut() {
                            match child.try_wait() {
                                Ok(Some(_)) => {
                                    guard.child = None;
                                    break;
                                }
                                Ok(None) => {}
                                Err(_) => break,
                            }
                        } else {
                            break;
                        }
                    }
                    if Instant::now() >= deadline {
                        let mut guard =
                            window_shared.lock().expect("service state poisoned");
                        if let Some(mut child) = guard.child.take() {
                            let _ = child.kill();
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the REALM desktop application");
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn server_url_accepts_plain_http_origins() {
        assert_eq!(
            normalize_server_url("http://127.0.0.1:9999").unwrap(),
            "http://127.0.0.1:9999"
        );
        assert_eq!(
            normalize_server_url("https://realm.example.cn/").unwrap(),
            "https://realm.example.cn"
        );
        assert_eq!(
            normalize_server_url(" http://192.168.1.20:9999/ ").unwrap(),
            "http://192.168.1.20:9999"
        );
    }

    #[test]
    fn server_url_rejects_credentials_and_non_http() {
        assert!(normalize_server_url("http://user:pass@127.0.0.1:9999").is_err());
        assert!(normalize_server_url("http://token@127.0.0.1:9999").is_err());
        assert!(normalize_server_url("file:///etc/passwd").is_err());
        assert!(normalize_server_url("tauri://localhost").is_err());
        assert!(normalize_server_url("ftp://127.0.0.1").is_err());
        assert!(normalize_server_url("http://127.0.0.1:9999?token=x").is_err());
        assert!(normalize_server_url("http://127.0.0.1:9999#frag").is_err());
        assert!(normalize_server_url("http://").is_err());
        assert!(normalize_server_url("").is_err());
    }

    #[test]
    fn invite_url_accepts_plain_server_and_lobby_deeplink() {
        let plain = normalize_invite_url("http://192.168.1.20:9999").unwrap();
        assert_eq!(plain.server_url, "http://192.168.1.20:9999");
        assert_eq!(plain.lobby_room_id, None);
        let with_slash = normalize_invite_url("https://realm.example.cn/").unwrap();
        assert_eq!(with_slash.server_url, "https://realm.example.cn");
        let invite = normalize_invite_url(
            "http://192.168.1.20:9999/?lobby=lobby_0123456789abcdef01234567",
        )
        .unwrap();
        assert_eq!(invite.server_url, "http://192.168.1.20:9999");
        assert_eq!(
            invite.lobby_room_id.as_deref(),
            Some("lobby_0123456789abcdef01234567")
        );
    }

    #[test]
    fn invite_url_rejects_credentials_paths_queries_and_bad_room_ids() {
        for bad in [
            "http://user:pass@192.168.1.20:9999/?lobby=lobby_0123456789abcdef01234567",
            "http://192.168.1.20:9999/?lobby=lobby_0123456789abcdef01234567#frag",
            "http://192.168.1.20:9999/some/path?lobby=lobby_0123456789abcdef01234567",
            "http://192.168.1.20:9999/?token=abc&lobby=lobby_0123456789abcdef01234567",
            "http://192.168.1.20:9999/?lobby=lobby_0123456789abcdef01234567&lobby=lobby_76543210fedcba9876543210",
            "http://192.168.1.20:9999/?",
            "http://192.168.1.20:9999/?&",
            "http://192.168.1.20:9999/?lobby=lobby_short",
            "http://192.168.1.20:9999/?lobby=lobby_0123456789ABCDEF01234567",
            "http://192.168.1.20:9999/?lobby=notlobby_0123456789abcdef012345",
            "ftp://192.168.1.20/?lobby=lobby_0123456789abcdef01234567",
            "not-a-url",
        ] {
            assert!(normalize_invite_url(bad).is_err(), "{bad} must fail");
        }
        // 错误消息不回显原始输入（可能内嵌凭据）。
        let error = normalize_invite_url("http://user:hunter2@192.168.1.20/?lobby=lobby_0123456789abcdef01234567")
            .unwrap_err();
        assert!(!error.contains("hunter2"));
    }

    #[test]
    fn advertised_origin_must_be_a_plain_origin() {
        assert_eq!(
            normalize_advertised_origin("http://192.168.1.20:9999").unwrap(),
            "http://192.168.1.20:9999"
        );
        assert_eq!(
            normalize_advertised_origin("https://realm.example.cn/").unwrap(),
            "https://realm.example.cn"
        );
        for bad in [
            "http://user:pass@192.168.1.20",
            "http://192.168.1.20:9999/admin",
            "http://192.168.1.20:9999?token=x",
            "ftp://192.168.1.20",
            "not-a-url",
        ] {
            assert!(normalize_advertised_origin(bad).is_err(), "{bad} must fail");
        }
    }

    #[test]
    fn lan_bind_accepts_explicit_ipv4_and_rejects_ambiguous_hosts() {
        assert_eq!(normalize_lan_bind(" 192.168.1.20 ").unwrap(), "192.168.1.20");
        assert_eq!(normalize_lan_bind("0.0.0.0").unwrap(), "0.0.0.0");
        for bad in ["", "localhost", "192.168.1", "256.1.1.1", "192.168.1.20:9999"] {
            assert!(normalize_lan_bind(bad).is_err(), "{bad} must fail");
        }
    }

    #[test]
    fn frames_drive_the_state_machine() {
        let idle = ServicePhase::Idle;
        let step = serde_json::json!({"type": "step", "step": "postgres"});
        let ready = serde_json::json!({"type": "ready", "url": "http://127.0.0.1:9999/"});
        let error = serde_json::json!({"type": "error", "kind": "already-running", "message": "x"});
        assert_eq!(
            apply_frame(&idle, &step),
            Some(ServicePhase::Starting { step: "postgres".into() })
        );
        let starting = apply_frame(&idle, &step).unwrap();
        assert_eq!(
            apply_frame(&starting, &ready),
            Some(ServicePhase::Ready {
                url: "http://127.0.0.1:9999/".into(),
                advertised_origin: None,
            })
        );
        let ready_phase = apply_frame(&starting, &ready).unwrap();
        // ready 后 step 帧不回退状态。
        assert_eq!(apply_frame(&ready_phase, &step), None);
        assert_eq!(
            apply_frame(&starting, &error),
            Some(ServicePhase::Failed { kind: "already-running".into(), message: "x".into() })
        );
        let stopping = serde_json::json!({"type": "stopping"});
        let stopping_phase = apply_frame(&ready_phase, &stopping).unwrap();
        assert_eq!(stopping_phase, ServicePhase::Stopping);
        let stopped = serde_json::json!({"type": "stopped"});
        assert_eq!(
            apply_frame(&stopping_phase, &stopped),
            Some(ServicePhase::Stopped)
        );
    }

    #[test]
    fn packaged_resource_root_is_selected_when_present() {
        let root = std::env::temp_dir().join(format!(
            "realm-resource-test-{}",
            std::process::id()
        ));
        let host = root.join("realm/launcher/realm-service-host.mjs");
        std::fs::create_dir_all(host.parent().expect("host parent")).expect("resource dirs");
        std::fs::write(&host, "").expect("resource marker");
        assert_eq!(
            resource_realm_home_from_dir(&root),
            Some(root.join("realm"))
        );
        std::fs::remove_dir_all(root).expect("resource cleanup");
    }

    #[test]
    fn native_server_check_accepts_auth_response_without_cors() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).expect("read test request");
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .expect("write test response");
        });
        let result = tauri::async_runtime::block_on(check_server(format!("http://{address}")))
            .expect("HTTP 401 proves the service is reachable");
        assert_eq!(result.status, 401);
        server.join().expect("join test server");
    }
}
