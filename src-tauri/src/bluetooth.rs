use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, CentralEvent};
use btleplug::platform::Manager;
use futures::StreamExt;
use tauri::Emitter;
use crate::models::{AppState, DeviceInfo, DeviceState, RssiReading, SseMessage};
use crate::store;

// OUI manufacturer prefixes (first 3 bytes of MAC)
lazy_static::lazy_static! {
    static ref OUI_MANUFACTURERS: HashMap<&'static str, &'static str> = {
        let mut m = HashMap::new();
        m.insert("ac:de:48", "Apple"); m.insert("f0:db:f8", "Apple");
        m.insert("3c:06:30", "Apple"); m.insert("14:98:77", "Apple");
        m.insert("00:1a:7d", "Samsung"); m.insert("cc:07:ab", "Samsung");
        m.insert("8c:f5:a3", "Samsung"); m.insert("00:26:5f", "Samsung");
        m.insert("00:1e:c2", "Apple"); m.insert("a8:51:5b", "Apple");
        m.insert("00:03:93", "Apple"); m.insert("e4:c6:3d", "Apple");
        m.insert("b8:27:eb", "Raspberry Pi"); m.insert("dc:a6:32", "Raspberry Pi");
        m.insert("58:cb:52", "Google"); m.insert("f4:f5:d8", "Google");
        m.insert("f8:a2:d6", "Amazon"); m.insert("f0:f0:a4", "Amazon");
        m.insert("98:d3:31", "Sony"); m.insert("00:1d:ba", "Sony");
        m.insert("fc:a1:83", "Bose"); m.insert("04:52:c7", "Bose");
        m.insert("00:1b:66", "JBL"); m.insert("b8:f6:53", "JBL");
        m.insert("00:02:5b", "Logitech"); m.insert("00:1f:20", "Logitech");
        m.insert("00:25:db", "Tile"); m.insert("00:21:4f", "Tile");
        m
    };
}

/// Infer device name from peripheral properties.
fn infer_device_name(local_name: Option<&str>, address: &str, manufacturer_data: &HashMap<u16, Vec<u8>>) -> (String, String) {
    // Try advertised name first
    if let Some(name) = local_name {
        if !name.is_empty() && !name.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return (name.to_string(), "advertised".to_string());
        }
    }

    // Try OUI lookup
    let addr_lower = address.to_lowercase();
    if addr_lower.len() >= 8 {
        let oui = &addr_lower[0..8];
        if let Some(manufacturer) = OUI_MANUFACTURERS.get(oui) {
            let suffix = if addr_lower.len() >= 5 {
                addr_lower[addr_lower.len()-5..].to_uppercase().replace(':', "")
            } else {
                String::new()
            };
            return (format!("{} Device ({})", manufacturer, suffix), "oui".to_string());
        }
    }

    // Check manufacturer data for company IDs
    for (company_id, _) in manufacturer_data {
        match *company_id {
            76 => return ("Apple Device".to_string(), "manufacturer".to_string()),
            6 => return ("Microsoft Device".to_string(), "manufacturer".to_string()),
            117 => return ("Samsung Device".to_string(), "manufacturer".to_string()),
            224 => return ("Google Device".to_string(), "manufacturer".to_string()),
            _ => {}
        }
    }

    ("Unknown Device".to_string(), "none".to_string())
}

fn get_device_list_type(lists: &crate::models::Lists, device_id: &str) -> Option<String> {
    if lists.blacklist.contains_key(device_id) { return Some("blacklist".to_string()); }
    if lists.greylist.contains_key(device_id) { return Some("greylist".to_string()); }
    if lists.whitelist.contains_key(device_id) { return Some("whitelist".to_string()); }
    None
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Initialize Bluetooth and start the event loop.
pub async fn init_bluetooth(app_handle: tauri::AppHandle, state: Arc<AppState>) {
    log::info!("Initializing Bluetooth...");

    let manager = match Manager::new().await {
        Ok(m) => m,
        Err(e) => {
            log::error!("Failed to create Bluetooth manager: {}", e);
            *state.bluetooth_state.write().await = "unavailable".to_string();
            let _ = app_handle.emit("bluetooth-state", "unavailable");
            return;
        }
    };

    let adapters = match manager.adapters().await {
        Ok(a) => a,
        Err(e) => {
            log::error!("Failed to get Bluetooth adapters: {}", e);
            *state.bluetooth_state.write().await = "unavailable".to_string();
            let _ = app_handle.emit("bluetooth-state", "unavailable");
            return;
        }
    };

    let adapter = match adapters.into_iter().next() {
        Some(a) => a,
        None => {
            log::error!("No Bluetooth adapters found");
            *state.bluetooth_state.write().await = "unavailable".to_string();
            let _ = app_handle.emit("bluetooth-state", "unavailable");
            return;
        }
    };

    // Store adapter reference
    *state.adapter.write().await = Some(adapter.clone());
    *state.bluetooth_state.write().await = "poweredOn".to_string();
    let _ = app_handle.emit("bluetooth-state", "poweredOn");
    log::info!("Bluetooth initialized successfully");

    // Start scanning automatically
    if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
        log::error!("Failed to start scanning: {}", e);
    } else {
        state.is_scanning.store(true, Ordering::SeqCst);
        let _ = app_handle.emit("scanning-state", true);
        log::info!("Started Bluetooth scanning");
    }

    // Event loop
    let events = match adapter.events().await {
        Ok(e) => e,
        Err(e) => {
            log::error!("Failed to get event stream: {}", e);
            return;
        }
    };

    let state_clone = state.clone();
    let app_clone = app_handle.clone();
    let adapter_clone = adapter.clone();

    tokio::spawn(async move {
        let mut events = events;
        while let Some(event) = events.next().await {
            match event {
                CentralEvent::DeviceDiscovered(id) => {
                    handle_device_event(&adapter_clone, &id, &state_clone, &app_clone).await;
                }
                CentralEvent::ManufacturerDataAdvertisement { id, .. } => {
                    handle_device_event(&adapter_clone, &id, &state_clone, &app_clone).await;
                }
                CentralEvent::ServiceDataAdvertisement { id, .. } => {
                    handle_device_event(&adapter_clone, &id, &state_clone, &app_clone).await;
                }
                CentralEvent::ServicesAdvertisement { id, .. } => {
                    handle_device_event(&adapter_clone, &id, &state_clone, &app_clone).await;
                }
                _ => {}
            }
        }
    });
}

async fn handle_device_event(
    adapter: &btleplug::platform::Adapter,
    id: &btleplug::platform::PeripheralId,
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
) {
    let peripheral = match adapter.peripheral(id).await {
        Ok(p) => p,
        Err(_) => return,
    };

    let properties = match peripheral.properties().await {
        Ok(Some(p)) => p,
        _ => return,
    };

    let device_id = id.to_string();
    let address = properties.address.to_string();
    let rssi = properties.rssi.unwrap_or(-100);
    let (name, name_source) = infer_device_name(
        properties.local_name.as_deref(),
        &address,
        &properties.manufacturer_data,
    );

    // Check blacklist
    let lists = state.store_data.read().await.lists.clone();
    if lists.blacklist.contains_key(&device_id) {
        return;
    }

    let now = now_ms();
    let list_type = get_device_list_type(&lists, &device_id);
    let is_unknown = name_source == "none";

    // Update device order
    {
        let mut data = state.store_data.write().await;
        if !data.device_order.contains(&device_id) {
            data.device_order.push(device_id.clone());
            if data.device_order.len() > 500 {
                data.device_order = data.device_order[data.device_order.len()-500..].to_vec();
            }
        }
    }

    // Get or create device info
    let first_seen = {
        let devices = state.discovered_devices.read().await;
        devices.get(&device_id).map(|d| d.first_seen).unwrap_or(now)
    };

    let device_info = DeviceInfo {
        id: device_id.clone(),
        name: name.clone(),
        name_source,
        rssi,
        first_seen,
        last_seen: now,
        address,
        is_unknown,
        list_type: list_type.clone(),
        _priority: None,
    };

    // Store device
    state.discovered_devices.write().await.insert(device_id.clone(), device_info.clone());

    // Track RSSI history
    {
        let mut history = state.rssi_history.write().await;
        let readings = history.entry(device_id.clone()).or_insert_with(Vec::new);
        readings.push(RssiReading { rssi, timestamp: now });
        if readings.len() > 30 {
            *readings = readings[readings.len()-30..].to_vec();
        }
    }

    // Handle whitelist/greylist devices
    if let Some(ref lt) = list_type {
        if lt == "whitelist" || lt == "greylist" {
            let was_online = {
                let states = state.device_states.read().await;
                states.get(&device_id).map(|s| s.online).unwrap_or(false)
            };

            // Update device state
            state.device_states.write().await.insert(device_id.clone(), DeviceState {
                online: true,
                last_seen: now,
            });

            // Update list entry
            {
                let mut data = state.store_data.write().await;
                if let Some(entry) = data.lists.whitelist.get_mut(&device_id) {
                    entry.last_seen = Some(now);
                    entry.online = true;
                }
                if let Some(entry) = data.lists.greylist.get_mut(&device_id) {
                    entry.last_seen = Some(now);
                    entry.online = true;
                }
            }

            // Notify if just came online
            if !was_online {
                log::info!("Device {} ({}) came online", name, device_id);
                let _ = app_handle.emit("device-status-change", serde_json::json!({
                    "deviceId": device_id,
                    "deviceName": name,
                    "status": "online",
                    "listType": lt
                }));

                // Show notification for whitelist only
                if lt == "whitelist" {
                    let settings = state.store_data.read().await.settings.clone();
                    if settings.notifications_enabled {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app_handle.notification()
                            .builder()
                            .title("Device Online")
                            .body(&format!("{} is now in range", name))
                            .show();
                    }
                }
            }
        }
    }

    // Broadcast SSE
    let _ = state.sse_tx.send(SseMessage {
        event_type: "device".to_string(),
        data: serde_json::to_value(&device_info).unwrap_or_default(),
    });
}

/// Check for devices that have gone offline.
pub async fn run_offline_checker(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
    loop {
        interval.tick().await;
        check_offline_devices(&state, &app_handle).await;
    }
}

async fn check_offline_devices(state: &Arc<AppState>, app_handle: &tauri::AppHandle) {
    let now = now_ms();
    let settings = state.store_data.read().await.settings.clone();
    let threshold = settings.offline_threshold;

    let lists = state.store_data.read().await.lists.clone();
    
    for (device_id, entry) in lists.whitelist.iter().chain(lists.greylist.iter()) {
        let device_state = state.device_states.read().await.get(device_id).cloned();
        
        if let Some(ds) = device_state {
            if ds.online && (now - ds.last_seen) > threshold {
                // Device went offline
                state.device_states.write().await.insert(device_id.clone(), DeviceState {
                    online: false,
                    last_seen: ds.last_seen,
                });

                // Update lists
                {
                    let mut data = state.store_data.write().await;
                    if let Some(e) = data.lists.whitelist.get_mut(device_id) {
                        e.online = false;
                    }
                    if let Some(e) = data.lists.greylist.get_mut(device_id) {
                        e.online = false;
                    }
                    let _ = store::save_store(&state.store_path, &data);
                }

                let list_type = if lists.whitelist.contains_key(device_id) {
                    "whitelist"
                } else {
                    "greylist"
                };

                log::info!("Device {} ({}) went offline", entry.name, device_id);

                let _ = app_handle.emit("device-status-change", serde_json::json!({
                    "deviceId": device_id,
                    "deviceName": entry.name,
                    "status": "offline",
                    "listType": list_type
                }));

                // Show notification for whitelist only
                if list_type == "whitelist" && settings.notifications_enabled {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app_handle.notification()
                        .builder()
                        .title("Device Offline")
                        .body(&format!("{} is no longer in range", entry.name))
                        .show();
                }
            }
        }
    }
}

/// Start Bluetooth scanning.
pub async fn start_scanning(state: &Arc<AppState>) -> Result<(), String> {
    let adapter = state.adapter.read().await;
    if let Some(ref adapter) = *adapter {
        adapter.start_scan(ScanFilter::default()).await
            .map_err(|e| format!("Failed to start scan: {}", e))?;
        state.is_scanning.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("Bluetooth adapter not available".to_string())
    }
}

/// Stop Bluetooth scanning.
pub async fn stop_scanning(state: &Arc<AppState>) -> Result<(), String> {
    let adapter = state.adapter.read().await;
    if let Some(ref adapter) = *adapter {
        adapter.stop_scan().await
            .map_err(|e| format!("Failed to stop scan: {}", e))?;
        state.is_scanning.store(false, Ordering::SeqCst);
        Ok(())
    } else {
        Err("Bluetooth adapter not available".to_string())
    }
}

/// Get aggregated devices for the UI.
pub async fn get_aggregated_devices(state: &Arc<AppState>) -> Vec<serde_json::Value> {
    let devices = state.discovered_devices.read().await;
    let lists = state.store_data.read().await.lists.clone();

    let mut listed: Vec<serde_json::Value> = Vec::new();
    let mut unique_named: Vec<serde_json::Value> = Vec::new();
    let mut apple_close: Vec<&DeviceInfo> = Vec::new();
    let mut apple_medium: Vec<&DeviceInfo> = Vec::new();
    let mut apple_far: Vec<&DeviceInfo> = Vec::new();
    let mut unknown: Vec<&DeviceInfo> = Vec::new();

    for device in devices.values() {
        if lists.blacklist.contains_key(&device.id) {
            continue;
        }

        let is_listed = lists.whitelist.contains_key(&device.id) || lists.greylist.contains_key(&device.id);

        if is_listed {
            listed.push(serde_json::to_value(device).unwrap_or_default());
        } else if device.name == "Apple Device" {
            if device.rssi > -70 {
                apple_close.push(device);
            } else if device.rssi > -85 {
                apple_medium.push(device);
            } else {
                apple_far.push(device);
            }
        } else if device.name == "Unknown Device" || device.is_unknown {
            unknown.push(device);
        } else {
            unique_named.push(serde_json::to_value(device).unwrap_or_default());
        }
    }

    let mut result = Vec::new();
    result.extend(listed);
    result.extend(unique_named);

    // Create group summaries
    if !apple_close.is_empty() {
        result.push(create_group_summary("Apple Devices (Close)", "apple-close", &apple_close));
    }
    if !apple_medium.is_empty() {
        result.push(create_group_summary("Apple Devices (Nearby)", "apple-medium", &apple_medium));
    }
    if !apple_far.is_empty() {
        result.push(create_group_summary("Apple Devices (Far)", "apple-far", &apple_far));
    }
    if !unknown.is_empty() {
        result.push(create_group_summary("Unknown Devices", "unknown", &unknown));
    }

    result
}

fn create_group_summary(name: &str, group_id: &str, devices: &[&DeviceInfo]) -> serde_json::Value {
    let rssis: Vec<i16> = devices.iter().map(|d| d.rssi).collect();
    let max_rssi = *rssis.iter().max().unwrap_or(&-100);
    let min_rssi = *rssis.iter().min().unwrap_or(&-100);
    let avg_rssi = rssis.iter().map(|r| *r as i32).sum::<i32>() / rssis.len().max(1) as i32;

    let last_seen = devices.iter().map(|d| d.last_seen).max().unwrap_or(0);
    let first_seen = devices.iter().map(|d| d.first_seen).min().unwrap_or(0);

    let top_devices: Vec<serde_json::Value> = devices.iter()
        .take(5)
        .map(|d| serde_json::json!({
            "id": d.id,
            "rssi": d.rssi,
            "lastSeen": d.last_seen
        }))
        .collect();

    serde_json::json!({
        "id": format!("__group_{}", group_id),
        "name": name,
        "isGroup": true,
        "groupId": group_id,
        "deviceCount": devices.len(),
        "randomMacCount": 0,
        "rssi": max_rssi,
        "rssiRange": {
            "min": min_rssi,
            "max": max_rssi,
            "avg": avg_rssi
        },
        "firstSeen": first_seen,
        "lastSeen": last_seen,
        "isUnknown": group_id == "unknown",
        "nameSource": "group",
        "topDevices": top_devices,
        "_priority": if group_id == "unknown" { 5 } else { 2 }
    })
}
