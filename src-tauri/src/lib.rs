#[macro_use]
extern crate lazy_static;

pub mod models;
pub mod store;
pub mod location;
pub mod bluetooth;
pub mod commands;
pub mod api_server;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;
use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder, MouseButton, MouseButtonState};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::{broadcast, RwLock};

use models::{AppState, ManagedState, StoreData};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // Initialize store path
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_dir).ok();
            let store_path = app_dir.join("store.json");

            // Load or create store
            let store_data = store::load_store(&store_path).unwrap_or_else(|e| {
                log::warn!("Failed to load store: {}, creating new", e);
                StoreData::default()
            });

            // Create SSE broadcast channel
            let (sse_tx, _) = broadcast::channel(100);

            // Build shared state
            let state = Arc::new(AppState {
                store_path,
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
                sse_tx,
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

                // Start HTTP API server
                let api_state = state_clone.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = api_server::start_api_server(api_state).await {
                        log::error!("API server error: {}", e);
                    }
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

            log::info!("Bluetooth Scanner started");
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
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().expect("no icon"))
        .menu(&menu)
        .tooltip("Bluetooth Scanner")
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "quit" => {
                    std::process::exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
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
