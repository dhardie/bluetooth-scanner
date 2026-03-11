use std::path::Path;
use crate::models::{StoreData, ActivityLogEntry};

const MAX_LOG_ENTRIES: usize = 500;
const MAX_LOG_AGE_DAYS: i64 = 30;
const MAX_RSSI_HISTORY: usize = 100;

/// Load persistent store from a JSON file, returning defaults if file doesn't exist.
pub fn load_store(path: &Path) -> Result<StoreData, String> {
    if !path.exists() {
        log::info!("Store file not found, using defaults: {:?}", path);
        return Ok(StoreData::default());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read store: {}", e))?;
    serde_json::from_str::<StoreData>(&content).map_err(|e| {
        log::warn!("Failed to parse store JSON, using defaults: {}", e);
        format!("Parse error: {}", e)
    }).or_else(|_| Ok(StoreData::default()))
}

/// Save persistent store to a JSON file.
pub fn save_store(path: &Path, data: &StoreData) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create store directory: {}", e))?;
    }
    let content = serde_json::to_string_pretty(data)
        .map_err(|e| format!("Failed to serialize store: {}", e))?;
    std::fs::write(path, content)
        .map_err(|e| format!("Failed to write store: {}", e))?;
    Ok(())
}

/// Clean up old activity log entries (called periodically)
pub fn cleanup_activity_log(data: &mut StoreData) -> usize {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let max_age_ms = (MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000) as u64;
    let cutoff = now.saturating_sub(max_age_ms);
    
    let original_len = data.activity_log.len();
    
    // Remove entries older than MAX_LOG_AGE_DAYS
    data.activity_log.retain(|entry| entry.timestamp > cutoff);
    
    // Trim to MAX_LOG_ENTRIES (keep most recent)
    if data.activity_log.len() > MAX_LOG_ENTRIES {
        // Sort by timestamp descending, then truncate
        data.activity_log.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        data.activity_log.truncate(MAX_LOG_ENTRIES);
    }
    
    let removed = original_len.saturating_sub(data.activity_log.len());
    if removed > 0 {
        log::info!("Cleaned up {} old activity log entries", removed);
    }
    removed
}

/// Aggregate sessions for a day (consolidate short sessions into daily summary)
pub fn aggregate_daily_sessions(data: &mut StoreData, device_id: &str) -> Option<ActivityLogEntry> {
    let now = chrono::Utc::now();
    let today_start = now.date_naive().and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as u64;
    
    // Get all completed sessions for this device today
    let today_sessions: Vec<_> = data.activity_log.iter()
        .filter(|e| {
            e.device_id == device_id && 
            e.session_id.is_some() && 
            e.end_time.is_some() &&
            e.timestamp >= today_start
        })
        .cloned()
        .collect();
    
    if today_sessions.len() < 3 {
        return None; // Not enough to aggregate
    }
    
    // Calculate totals
    let total_duration: u64 = today_sessions.iter()
        .filter_map(|s| s.duration)
        .sum();
    let total_dropouts: u32 = today_sessions.iter()
        .filter_map(|s| s.dropouts)
        .sum();
    let first_seen = today_sessions.iter().map(|s| s.timestamp).min()?;
    let last_seen = today_sessions.iter().filter_map(|s| s.end_time).max()?;
    
    // Create aggregated entry
    let device_name = today_sessions.first()?.device_name.clone();
    let list_type = today_sessions.first()?.list_type.clone();
    
    Some(ActivityLogEntry {
        timestamp: first_seen,
        session_id: Some(format!("daily-{}-{}", device_id.chars().take(8).collect::<String>(), today_start)),
        device_id: device_id.to_string(),
        device_name,
        event: "daily_summary".to_string(),
        status: Some("complete".to_string()),
        list_type,
        location: today_sessions.first()?.location.clone(),
        location_name: today_sessions.first()?.location_name.clone(),
        dropouts: Some(total_dropouts),
        duration: Some(total_duration),
        summary: Some(format!("{} sessions, {} total", today_sessions.len(), format_duration(total_duration))),
        end_time: Some(last_seen),
        last_update: Some(chrono::Utc::now().timestamp_millis() as u64),
        start_time: Some(first_seen),
        companions: None,
        nearby_unusual: None,
        movement: None,
        activator: None,
    })
}

fn format_duration(ms: u64) -> String {
    let secs = ms / 1000;
    let mins = secs / 60;
    let hours = mins / 60;
    if hours > 0 {
        format!("{}h {}m", hours, mins % 60)
    } else if mins > 0 {
        format!("{}m", mins)
    } else {
        format!("{}s", secs)
    }
}

/// Prune companion history to prevent unbounded growth
pub fn prune_companion_history(data: &mut StoreData) {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let max_age_ms: u64 = 90 * 24 * 60 * 60 * 1000; // 90 days
    let cutoff = now.saturating_sub(max_age_ms);
    
    for (_device_id, companions) in data.companion_history.iter_mut() {
        companions.retain(|_companion_id, entry| entry.last_seen > cutoff);
    }
    
    // Remove devices with no companions
    data.companion_history.retain(|_k, v| !v.is_empty());
}
