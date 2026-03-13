#[macro_use]
extern crate lazy_static;

pub mod models;
pub mod store;
pub mod location;
pub mod bluetooth;
pub mod commands;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;
use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind, RotationStrategy};
use tokio::sync::RwLock;

use models::{AppState, ManagedState, StoreData};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new()
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::LogDir { file_name: Some("bluetooth-scanner".to_string()) }),
                Target::new(TargetKind::Webview),
            ])
            .level(log::LevelFilter::Info)
            .level_for("btleplug", log::LevelFilter::Warn)
            .rotation_strategy(RotationStrategy::KeepAll)
            .max_file_size(5 * 1024 * 1024) // 5 MB
            .build()
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_dir).ok();
            
            // DB path (SQLite)
            let db_path = app_dir.join("bluetooth-scanner.db");
            
            // Migrate from JSON if needed
            let json_path = app_dir.join("store.json");
            if json_path.exists() {
                if let Err(e) = store::migrate_from_json(&json_path, &db_path) {
                    log::warn!("Migration from JSON failed: {}", e);
                }
            }

            // Load or create store from SQLite
            let store_data = store::load_store(&db_path).unwrap_or_else(|e| {
                log::warn!("Failed to load store: {}, creating new", e);
                StoreData::default()
            });

            // Build shared state (no more SSE broadcast needed)
            let state = Arc::new(AppState {
                store_path: db_path.clone(),
                store_data: RwLock::new(store_data),
                discovered_devices: RwLock::new(HashMap::new()),
                device_states: RwLock::new(HashMap::new()),
                rssi_history: RwLock::new(HashMap::new()),
                active_sessions: RwLock::new(HashMap::new()),
                bluetooth_state: RwLock::new("unknown".to_string()),
                is_scanning: AtomicBool::new(false),
                adapter: RwLock::new(None),
                companion_history: RwLock::new(HashMap::new()),
                co_location_history: RwLock::new(HashMap::new()),
            });

            // Manage state
            app.manage(ManagedState(state.clone()));

            // Set up system tray
            setup_tray(app)?;

            // Start background tasks
            let app_handle = app.handle().clone();
            let state_clone = state.clone();

            tauri::async_runtime::spawn(async move {
                // Initialize Bluetooth
                bluetooth::init_bluetooth(app_handle.clone(), state_clone.clone()).await;

                // Start offline checker
                let offline_state = state_clone.clone();
                let offline_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    bluetooth::run_offline_checker(offline_state, offline_handle).await;
                });

                // Start location detection loop
                let loc_state = state_clone.clone();
                let loc_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    location::detect_location_loop(loc_state, loc_handle).await;
                });

                // Start periodic device broadcast (every 3 seconds)
                let broadcast_state = state_clone.clone();
                let broadcast_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    run_device_broadcast(broadcast_state, broadcast_handle).await;
                });

                // Start daily cleanup task
                let cleanup_path = state_clone.store_path.clone();
                tauri::async_runtime::spawn(async move {
                    run_daily_cleanup(cleanup_path).await;
                });
            });

            // Handle window close to minimize to tray
            let main_window = app.get_webview_window("main");
            if let Some(window) = main_window {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            log::info!("Bluetooth Scanner started - SQLite storage active");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Getters
            commands::get_lists,
            commands::get_settings,
            commands::get_activity_log,
            commands::get_discovered_devices,
            commands::get_bluetooth_state,
            commands::get_scanning_state,
            // List actions
            commands::add_to_list,
            commands::remove_from_list,
            commands::move_to_list,
            commands::bulk_add_to_list,
            commands::update_device_name,
            // Settings
            commands::update_settings,
            commands::clear_activity_log,
            // Scanning
            commands::start_scanning,
            commands::stop_scanning,
            // Location
            commands::get_locations,
            commands::get_current_location,
            commands::get_current_coords,
            commands::set_location,
            commands::add_location,
            commands::update_location,
            commands::remove_location,
            commands::refresh_location,
            // Analytics & Stats
            commands::get_device_stats,
            commands::get_all_device_stats,
            commands::get_rssi_history,
            commands::get_companions,
            commands::get_analytics_summary,
            // Export
            commands::export_activity_log_csv,
            commands::export_devices_json,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

/// Broadcast aggregated device list every 3 seconds
async fn run_device_broadcast(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
    loop {
        interval.tick().await;
        let devices = bluetooth::get_aggregated_devices(&state).await;
        let _ = app_handle.emit("device-batch-update", &devices);
    }
}

/// Run cleanup tasks every 24 hours
async fn run_daily_cleanup(db_path: std::path::PathBuf) {
    // First cleanup after 1 hour of uptime
    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    loop {
        if let Err(e) = store::cleanup_old_data(&db_path) {
            log::warn!("Cleanup failed: {}", e);
        } else {
            log::info!("Daily cleanup completed");
        }
        tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let scan_toggle = MenuItem::with_id(app, "scan_toggle", "Toggle Scanning", true, None::<&str>)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &scan_toggle, &separator, &quit])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().expect("no icon"))
        .menu(&menu)
        .tooltip("Bluetooth Scanner")
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "quit" => {
                    log::info!("Quit from tray menu");
                    std::process::exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "scan_toggle" => {
                    let _ = app.emit("tray-scan-toggle", ());
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
