use std::sync::atomic::Ordering;
use tauri::{State, Emitter};
use crate::models::{ManagedState, Lists, Settings, DeviceEntry, Location, LocationInfo, Coords};
use crate::store;
use crate::bluetooth;
use crate::location;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ============================================================
// GETTERS
// ============================================================

#[tauri::command]
pub async fn get_lists(state: State<'_, ManagedState>) -> Result<Lists, String> {
    let data = state.0.store_data.read().await;
    Ok(data.lists.clone())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, ManagedState>) -> Result<Settings, String> {
    let data = state.0.store_data.read().await;
    Ok(data.settings.clone())
}

#[tauri::command]
pub async fn get_activity_log(state: State<'_, ManagedState>) -> Result<Vec<serde_json::Value>, String> {
    // Fetch directly from SQLite for up-to-date data
    let entries = store::get_activity_log_db(&state.0.store_path, 500)?;
    let log: Vec<serde_json::Value> = entries.iter()
        .map(|e| serde_json::to_value(e).unwrap_or_default())
        .collect();
    Ok(log)
}

#[tauri::command]
pub async fn get_discovered_devices(state: State<'_, ManagedState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(bluetooth::get_aggregated_devices(&state.0).await)
}

#[tauri::command]
pub async fn get_bluetooth_state(state: State<'_, ManagedState>) -> Result<String, String> {
    let bt_state = state.0.bluetooth_state.read().await;
    Ok(bt_state.clone())
}

#[tauri::command]
pub async fn get_scanning_state(state: State<'_, ManagedState>) -> Result<bool, String> {
    Ok(state.0.is_scanning.load(Ordering::SeqCst))
}

// ============================================================
// LIST ACTIONS
// ============================================================

#[tauri::command]
pub async fn add_to_list(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    device_id: String,
    device_name: String,
    list_type: String,
) -> Result<Lists, String> {
    log::info!("add_to_list: device_id={}, device_name={}, list_type={}", device_id, device_name, list_type);
    
    let now = now_ms();
    
    let mut data = state.0.store_data.write().await;
    
    // Remove from all lists first
    data.lists.blacklist.remove(&device_id);
    data.lists.greylist.remove(&device_id);
    data.lists.whitelist.remove(&device_id);
    
    // Add to specified list
    let entry = DeviceEntry {
        name: device_name.clone(),
        added_at: now,
        last_seen: None,
        online: false,
    };
    
    match list_type.as_str() {
        "blacklist" => { data.lists.blacklist.insert(device_id.clone(), entry); }
        "greylist" => { data.lists.greylist.insert(device_id.clone(), entry); }
        "whitelist" => { data.lists.whitelist.insert(device_id.clone(), entry); }
        _ => return Err(format!("Invalid list type: {}", list_type)),
    }
    
    let lists = data.lists.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    drop(data);
    
    let _ = handle.emit("lists-updated", &lists);
    log::info!("Device {} added to {}", device_id, list_type);
    Ok(lists)
}

#[tauri::command]
pub async fn remove_from_list(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    device_id: String,
    list_type: String,
) -> Result<Lists, String> {
    let mut data = state.0.store_data.write().await;
    
    match list_type.as_str() {
        "blacklist" => { data.lists.blacklist.remove(&device_id); }
        "greylist" => { data.lists.greylist.remove(&device_id); }
        "whitelist" => { data.lists.whitelist.remove(&device_id); }
        _ => return Err(format!("Invalid list type: {}", list_type)),
    }
    
    // Also remove from device states
    state.0.device_states.write().await.remove(&device_id);
    
    let lists = data.lists.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    drop(data);
    
    let _ = handle.emit("lists-updated", &lists);
    Ok(lists)
}

#[tauri::command]
pub async fn move_to_list(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    device_id: String,
    from_list: String,
    to_list: String,
) -> Result<Lists, String> {
    let mut data = state.0.store_data.write().await;
    
    let entry = match from_list.as_str() {
        "blacklist" => data.lists.blacklist.remove(&device_id),
        "greylist" => data.lists.greylist.remove(&device_id),
        "whitelist" => data.lists.whitelist.remove(&device_id),
        _ => return Err(format!("Invalid from_list: {}", from_list)),
    };
    
    if let Some(entry) = entry {
        match to_list.as_str() {
            "blacklist" => { data.lists.blacklist.insert(device_id, entry); }
            "greylist" => { data.lists.greylist.insert(device_id, entry); }
            "whitelist" => { data.lists.whitelist.insert(device_id, entry); }
            _ => return Err(format!("Invalid to_list: {}", to_list)),
        }
    }
    
    let lists = data.lists.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    drop(data);
    
    let _ = handle.emit("lists-updated", &lists);
    Ok(lists)
}

#[tauri::command]
pub async fn bulk_add_to_list(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    devices: Vec<serde_json::Value>,
    list_type: String,
) -> Result<Lists, String> {
    let now = now_ms();
    let mut data = state.0.store_data.write().await;
    
    for device in devices {
        let id = device["id"].as_str().unwrap_or_default().to_string();
        let name = device["name"].as_str().unwrap_or("Unknown").to_string();
        
        if id.is_empty() { continue; }
        
        data.lists.blacklist.remove(&id);
        data.lists.greylist.remove(&id);
        data.lists.whitelist.remove(&id);
        
        let entry = DeviceEntry {
            name,
            added_at: now,
            last_seen: None,
            online: false,
        };
        
        match list_type.as_str() {
            "blacklist" => { data.lists.blacklist.insert(id, entry); }
            "greylist" => { data.lists.greylist.insert(id, entry); }
            "whitelist" => { data.lists.whitelist.insert(id, entry); }
            _ => {}
        }
    }
    
    let lists = data.lists.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    drop(data);
    
    let _ = handle.emit("lists-updated", &lists);
    Ok(lists)
}

#[tauri::command]
pub async fn update_device_name(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    device_id: String,
    name: String,
) -> Result<Lists, String> {
    let mut data = state.0.store_data.write().await;
    
    if let Some(entry) = data.lists.blacklist.get_mut(&device_id) { entry.name = name.clone(); }
    if let Some(entry) = data.lists.greylist.get_mut(&device_id) { entry.name = name.clone(); }
    if let Some(entry) = data.lists.whitelist.get_mut(&device_id) { entry.name = name.clone(); }
    
    let lists = data.lists.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    drop(data);
    
    let _ = handle.emit("lists-updated", &lists);
    Ok(lists)
}

// ============================================================
// SETTINGS
// ============================================================

#[tauri::command]
pub async fn update_settings(
    state: State<'_, ManagedState>,
    settings: Settings,
) -> Result<Settings, String> {
    let mut data = state.0.store_data.write().await;
    data.settings = settings.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    log::info!("Settings updated");
    Ok(settings)
}

#[tauri::command]
pub async fn clear_activity_log(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
) -> Result<Vec<serde_json::Value>, String> {
    // Clear from SQLite
    store::clear_activity_log_db(&state.0.store_path)?;
    
    // Clear in-memory cache
    let mut data = state.0.store_data.write().await;
    data.activity_log.clear();
    drop(data);
    
    let _ = handle.emit("activity-log-updated", Vec::<serde_json::Value>::new());
    log::info!("Activity log cleared");
    Ok(vec![])
}

// ============================================================
// SCANNING CONTROL
// ============================================================

#[tauri::command]
pub async fn start_scanning(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
) -> Result<bool, String> {
    bluetooth::start_scanning(&state.0).await?;
    let _ = handle.emit("scanning-state", true);
    log::info!("Scanning started");
    Ok(true)
}

#[tauri::command]
pub async fn stop_scanning(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
) -> Result<bool, String> {
    bluetooth::stop_scanning(&state.0).await?;
    let _ = handle.emit("scanning-state", false);
    log::info!("Scanning stopped");
    Ok(false)
}

// ============================================================
// LOCATION
// ============================================================

#[tauri::command]
pub async fn get_locations(state: State<'_, ManagedState>) -> Result<Vec<Location>, String> {
    let data = state.0.store_data.read().await;
    Ok(data.locations.clone())
}

#[tauri::command]
pub async fn get_current_location(state: State<'_, ManagedState>) -> Result<LocationInfo, String> {
    let data = state.0.store_data.read().await;
    let loc_name = data.current_location.as_ref()
        .and_then(|id| data.locations.iter().find(|l| &l.id == id))
        .map(|l| l.name.clone());
    
    Ok(LocationInfo {
        id: data.current_location.clone(),
        name: loc_name,
        coords: data.current_coords.clone(),
        is_unknown: data.current_location.is_none(),
    })
}

#[tauri::command]
pub async fn get_current_coords(state: State<'_, ManagedState>) -> Result<Option<Coords>, String> {
    let data = state.0.store_data.read().await;
    Ok(data.current_coords.clone())
}

#[tauri::command]
pub async fn set_location(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    location_id: String,
) -> Result<serde_json::Value, String> {
    let mut data = state.0.store_data.write().await;
    data.current_location = Some(location_id.clone());
    
    let loc_name = data.locations.iter()
        .find(|l| l.id == location_id)
        .map(|l| l.name.clone())
        .unwrap_or_default();
    
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    drop(data);
    
    let result = serde_json::json!({ "id": location_id, "name": loc_name });
    let _ = handle.emit("location-changed", &result);
    Ok(result)
}

#[tauri::command]
pub async fn add_location(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
    name: String,
    lat: Option<f64>,
    lon: Option<f64>,
    radius_km: Option<f64>,
) -> Result<serde_json::Value, String> {
    let mut data = state.0.store_data.write().await;
    
    let use_lat = lat.or_else(|| data.current_coords.as_ref().map(|c| c.lat));
    let use_lon = lon.or_else(|| data.current_coords.as_ref().map(|c| c.lon));
    
    let (lat, lon) = match (use_lat, use_lon) {
        (Some(lt), Some(ln)) => (lt, ln),
        _ => return Err("No coordinates available".to_string()),
    };
    
    let id = format!("loc-{}-{}", now_ms(), &uuid::Uuid::new_v4().to_string()[..5]);
    
    let new_loc = Location {
        id: id.clone(),
        name: name.clone(),
        lat,
        lon,
        radius_km: radius_km.unwrap_or(5.0),
    };
    
    data.locations.push(new_loc.clone());
    data.current_location = Some(id.clone());
    
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    
    let locations = data.locations.clone();
    drop(data);
    
    let _ = handle.emit("location-changed", serde_json::json!({ "id": id, "name": name }));
    log::info!("Location added: {} ({:.4}, {:.4})", name, lat, lon);
    
    Ok(serde_json::json!({
        "locations": locations,
        "newLocation": new_loc
    }))
}

#[tauri::command]
pub async fn update_location(
    state: State<'_, ManagedState>,
    id: String,
    name: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    radius_km: Option<f64>,
) -> Result<Vec<Location>, String> {
    let mut data = state.0.store_data.write().await;
    
    if let Some(loc) = data.locations.iter_mut().find(|l| l.id == id) {
        if let Some(n) = name { loc.name = n; }
        if let Some(lt) = lat { loc.lat = lt; }
        if let Some(ln) = lon { loc.lon = ln; }
        if let Some(r) = radius_km { loc.radius_km = r; }
    }
    
    let locations = data.locations.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    
    Ok(locations)
}

#[tauri::command]
pub async fn remove_location(
    state: State<'_, ManagedState>,
    location_id: String,
) -> Result<Vec<Location>, String> {
    let mut data = state.0.store_data.write().await;
    
    data.locations.retain(|l| l.id != location_id);
    
    if data.current_location.as_ref() == Some(&location_id) {
        data.current_location = None;
    }
    
    let locations = data.locations.clone();
    store::save_store(&state.0.store_path, &data).map_err(|e| e.to_string())?;
    
    Ok(locations)
}

#[tauri::command]
pub async fn refresh_location(
    handle: tauri::AppHandle,
    state: State<'_, ManagedState>,
) -> Result<LocationInfo, String> {
    location::detect_location(&state.0, &handle).await;
    
    let data = state.0.store_data.read().await;
    let loc_name = data.current_location.as_ref()
        .and_then(|id| data.locations.iter().find(|l| &l.id == id))
        .map(|l| l.name.clone());
    
    Ok(LocationInfo {
        id: data.current_location.clone(),
        name: loc_name,
        coords: data.current_coords.clone(),
        is_unknown: data.current_location.is_none(),
    })
}

// ============================================================
// ANALYTICS & STATS
// ============================================================

#[tauri::command]
pub async fn get_device_stats(
    state: State<'_, ManagedState>,
    device_id: String,
) -> Result<Option<serde_json::Value>, String> {
    store::get_device_stats_db(&state.0.store_path, &device_id)
}

#[tauri::command]
pub async fn get_all_device_stats(
    state: State<'_, ManagedState>,
) -> Result<Vec<serde_json::Value>, String> {
    store::get_all_device_stats(&state.0.store_path)
}

#[tauri::command]
pub async fn get_rssi_history(
    state: State<'_, ManagedState>,
    device_id: String,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    // First check in-memory history for recent readings
    let in_memory = {
        let history = state.0.rssi_history.read().await;
        history.get(&device_id).cloned()
    };
    
    if let Some(readings) = in_memory {
        if !readings.is_empty() {
            return Ok(readings.iter().map(|r| serde_json::json!({
                "timestamp": r.timestamp,
                "rssi": r.rssi
            })).collect());
        }
    }
    
    // Fall back to SQLite
    let history = store::get_rssi_history_db(&state.0.store_path, &device_id, limit.unwrap_or(60))?;
    Ok(history.iter().map(|(ts, rssi)| serde_json::json!({
        "timestamp": ts,
        "rssi": rssi
    })).collect())
}

#[tauri::command]
pub async fn get_companions(
    state: State<'_, ManagedState>,
    device_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    store::get_companions_db(&state.0.store_path, &device_id)
}

#[tauri::command]
pub async fn get_analytics_summary(
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let data = state.0.store_data.read().await;
    let discovered_count = state.0.discovered_devices.read().await.len();
    let device_states = state.0.device_states.read().await;
    
    let devices_online = device_states.values().filter(|s| s.online).count();
    let total_tracked = data.lists.whitelist.len() + data.lists.greylist.len();
    
    drop(device_states);
    drop(data);
    
    // Get aggregate stats from SQLite
    let all_stats = store::get_all_device_stats(&state.0.store_path).unwrap_or_default();
    
    let total_sessions: i64 = all_stats.iter()
        .filter_map(|s| s["totalSessions"].as_i64())
        .sum();
    
    let total_duration_ms: i64 = all_stats.iter()
        .filter_map(|s| s["totalDurationMs"].as_i64())
        .sum();
    
    let avg_session_ms = if total_sessions > 0 {
        total_duration_ms / total_sessions
    } else {
        0
    };
    
    let most_seen_device = all_stats.first()
        .and_then(|s| s["deviceName"].as_str().map(String::from));
    
    // Get DB file size
    let db_size = std::fs::metadata(&state.0.store_path)
        .map(|m| m.len())
        .unwrap_or(0);
    
    // Build location frequency from recent activity log
    let entries = store::get_activity_log_db(&state.0.store_path, 1000).unwrap_or_default();
    let mut location_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for entry in &entries {
        if let Some(loc) = &entry.location_name {
            if !loc.is_empty() {
                *location_counts.entry(loc.clone()).or_insert(0) += 1;
            }
        }
    }
    let most_seen_location = location_counts.into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(loc, _)| loc);
    
    Ok(serde_json::json!({
        "totalDevicesSeen": discovered_count,
        "totalTrackedDevices": total_tracked,
        "totalSessions": total_sessions,
        "totalTimTrackedMs": total_duration_ms,
        "mostSeenDevice": most_seen_device,
        "mostSeenLocation": most_seen_location,
        "avgSessionDurationMs": avg_session_ms,
        "devicesOnlineNow": devices_online,
        "dbSizeBytes": db_size,
        "deviceStatCount": all_stats.len()
    }))
}

// ============================================================
// EXPORT
// ============================================================

#[tauri::command]
pub async fn export_activity_log_csv(
    state: State<'_, ManagedState>,
) -> Result<String, String> {
    log::info!("Exporting activity log as CSV");
    store::export_activity_log_csv(&state.0.store_path)
}

#[tauri::command]
pub async fn export_devices_json(
    state: State<'_, ManagedState>,
) -> Result<String, String> {
    let data = state.0.store_data.read().await;
    let export = serde_json::json!({
        "exportedAt": now_ms(),
        "whitelist": data.lists.whitelist,
        "greylist": data.lists.greylist,
        "blacklist": data.lists.blacklist,
        "locations": data.locations,
        "settings": data.settings
    });
    
    serde_json::to_string_pretty(&export)
        .map_err(|e| format!("Failed to serialize: {}", e))
}
