use std::path::Path;
use rusqlite::{Connection, params};
use crate::models::{StoreData, ActivityLogEntry, Lists, DeviceEntry, Settings, Location, Coords};
use std::collections::HashMap;

pub struct Database {
    pub path: std::path::PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(path)
            .map_err(|e| format!("Failed to open database: {}", e))?;
        
        // Enable WAL mode for better concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| format!("Failed to set WAL mode: {}", e))?;
        
        Ok(conn)
    }
    
    pub fn init(conn: &Connection) -> Result<(), String> {
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS device_lists (
                device_id TEXT NOT NULL,
                list_type TEXT NOT NULL CHECK(list_type IN ('whitelist','greylist','blacklist')),
                name TEXT NOT NULL DEFAULT '',
                added_at INTEGER NOT NULL DEFAULT 0,
                last_seen INTEGER,
                online INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (device_id, list_type)
            );
            
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                session_id TEXT,
                device_id TEXT NOT NULL,
                device_name TEXT NOT NULL,
                event TEXT NOT NULL,
                status TEXT,
                list_type TEXT,
                location_id TEXT,
                location_name TEXT,
                dropouts INTEGER,
                duration INTEGER,
                summary TEXT,
                end_time INTEGER,
                last_update INTEGER,
                start_time INTEGER,
                companions_json TEXT,
                movement_json TEXT,
                activator_json TEXT,
                nearby_unusual_json TEXT
            );
            
            CREATE INDEX IF NOT EXISTS idx_activity_log_device ON activity_log(device_id);
            CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_activity_log_session ON activity_log(session_id);
            
            CREATE TABLE IF NOT EXISTS locations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                radius_km REAL NOT NULL DEFAULT 5.0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            
            CREATE TABLE IF NOT EXISTS rssi_history (
                device_id TEXT NOT NULL,
                rssi INTEGER NOT NULL,
                timestamp INTEGER NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_rssi_device ON rssi_history(device_id, timestamp DESC);
            
            CREATE TABLE IF NOT EXISTS companion_history (
                device_id TEXT NOT NULL,
                companion_id TEXT NOT NULL,
                companion_name TEXT NOT NULL DEFAULT '',
                count INTEGER NOT NULL DEFAULT 0,
                first_seen INTEGER NOT NULL DEFAULT 0,
                last_seen INTEGER NOT NULL DEFAULT 0,
                avg_rssi INTEGER NOT NULL DEFAULT -80,
                PRIMARY KEY (device_id, companion_id)
            );
            
            CREATE TABLE IF NOT EXISTS device_stats (
                device_id TEXT PRIMARY KEY,
                device_name TEXT NOT NULL,
                list_type TEXT,
                total_sessions INTEGER NOT NULL DEFAULT 0,
                total_duration_ms INTEGER NOT NULL DEFAULT 0,
                total_dropouts INTEGER NOT NULL DEFAULT 0,
                first_seen INTEGER,
                last_seen INTEGER,
                locations_seen TEXT NOT NULL DEFAULT '[]'
            );
            
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ").map_err(|e| format!("Failed to init database schema: {}", e))?;
        
        log::info!("Database schema initialized");
        Ok(())
    }
}

// ============================================================
// LOAD FULL STORE DATA
// ============================================================

pub fn load_store(path: &Path) -> Result<StoreData, String> {
    let conn = Database::open(path)?;
    Database::init(&conn)?;
    
    let mut data = StoreData::default();
    
    // Load device lists
    {
        let mut stmt = conn.prepare(
            "SELECT device_id, list_type, name, added_at, last_seen, online FROM device_lists"
        ).map_err(|e| e.to_string())?;
        
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?,
                row.get::<_, Option<u64>>(4)?,
                row.get::<_, bool>(5)?,
            ))
        }).map_err(|e| e.to_string())?;
        
        for row in rows {
            let (device_id, list_type, name, added_at, last_seen, online) = row.map_err(|e| e.to_string())?;
            let entry = DeviceEntry { name, added_at, last_seen, online };
            match list_type.as_str() {
                "whitelist" => { data.lists.whitelist.insert(device_id, entry); }
                "greylist" => { data.lists.greylist.insert(device_id, entry); }
                "blacklist" => { data.lists.blacklist.insert(device_id, entry); }
                _ => {}
            }
        }
    }
    
    // Load locations
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, lat, lon, radius_km FROM locations ORDER BY sort_order ASC"
        ).map_err(|e| e.to_string())?;
        
        let rows = stmt.query_map([], |row| {
            Ok(Location {
                id: row.get(0)?,
                name: row.get(1)?,
                lat: row.get(2)?,
                lon: row.get(3)?,
                radius_km: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;
        
        for row in rows {
            data.locations.push(row.map_err(|e| e.to_string())?);
        }
    }
    
    // Load settings
    {
        let mut stmt = conn.prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        
        let mut settings_map: HashMap<String, String> = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            settings_map.insert(k, v);
        }
        
        if !settings_map.is_empty() {
            data.settings = Settings {
                scan_interval: settings_map.get("scan_interval").and_then(|v| v.parse().ok()).unwrap_or(10000),
                offline_threshold: settings_map.get("offline_threshold").and_then(|v| v.parse().ok()).unwrap_or(30000),
                notifications_enabled: settings_map.get("notifications_enabled").and_then(|v| v.parse().ok()).unwrap_or(true),
                start_minimized: settings_map.get("start_minimized").and_then(|v| v.parse().ok()).unwrap_or(false),
                minimize_to_tray: settings_map.get("minimize_to_tray").and_then(|v| v.parse().ok()).unwrap_or(true),
            };
        }
    }
    
    // Load app state (current location, coords)
    {
        let mut stmt = conn.prepare("SELECT key, value FROM app_state")
            .map_err(|e| e.to_string())?;
        
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            match k.as_str() {
                "current_location" => {
                    data.current_location = if v.is_empty() { None } else { Some(v) };
                }
                "current_coords" => {
                    if let Ok(coords) = serde_json::from_str::<Coords>(&v) {
                        data.current_coords = Some(coords);
                    }
                }
                _ => {}
            }
        }
    }
    
    // Load activity log (last 200 entries)
    {
        let mut stmt = conn.prepare(
            "SELECT timestamp, session_id, device_id, device_name, event, status, list_type,
                    location_id, location_name, dropouts, duration, summary, end_time, 
                    last_update, start_time, companions_json, movement_json, activator_json, nearby_unusual_json
             FROM activity_log 
             ORDER BY timestamp DESC 
             LIMIT 200"
        ).map_err(|e| e.to_string())?;
        
        let rows = stmt.query_map([], |row| {
            Ok(ActivityLogEntry {
                timestamp: row.get(0)?,
                session_id: row.get(1)?,
                device_id: row.get(2)?,
                device_name: row.get(3)?,
                event: row.get(4)?,
                status: row.get(5)?,
                list_type: row.get(6)?,
                location: row.get(7)?,
                location_name: row.get(8)?,
                dropouts: row.get(9)?,
                duration: row.get(10)?,
                summary: row.get(11)?,
                end_time: row.get(12)?,
                last_update: row.get(13)?,
                start_time: row.get(14)?,
                companions: row.get::<_, Option<String>>(15)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
                movement: row.get::<_, Option<String>>(16)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
                activator: row.get::<_, Option<String>>(17)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
                nearby_unusual: row.get::<_, Option<String>>(18)?
                    .and_then(|s| serde_json::from_str(&s).ok()),
            })
        }).map_err(|e| e.to_string())?;
        
        for row in rows {
            data.activity_log.push(row.map_err(|e| e.to_string())?);
        }
        
        // Reverse to get chronological order (we fetched DESC)
        data.activity_log.reverse();
    }
    
    log::info!("Store loaded from SQLite: {} devices, {} locations, {} log entries",
        data.lists.whitelist.len() + data.lists.greylist.len() + data.lists.blacklist.len(),
        data.locations.len(),
        data.activity_log.len()
    );
    
    Ok(data)
}

// ============================================================
// SAVE OPERATIONS
// ============================================================

pub fn save_store(path: &Path, data: &StoreData) -> Result<(), String> {
    let conn = Database::open(path)?;
    
    save_lists(&conn, &data.lists)?;
    save_settings(&conn, &data.settings)?;
    save_locations(&conn, &data.locations)?;
    save_app_state(&conn, data)?;
    
    Ok(())
}

pub fn save_lists(conn: &Connection, lists: &Lists) -> Result<(), String> {
    // Use REPLACE to upsert
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO device_lists (device_id, list_type, name, added_at, last_seen, online) 
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).map_err(|e| e.to_string())?;
    
    for (id, entry) in &lists.whitelist {
        stmt.execute(params![id, "whitelist", entry.name, entry.added_at, entry.last_seen, entry.online])
            .map_err(|e| e.to_string())?;
    }
    for (id, entry) in &lists.greylist {
        stmt.execute(params![id, "greylist", entry.name, entry.added_at, entry.last_seen, entry.online])
            .map_err(|e| e.to_string())?;
    }
    for (id, entry) in &lists.blacklist {
        stmt.execute(params![id, "blacklist", entry.name, entry.added_at, entry.last_seen, entry.online])
            .map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

pub fn remove_from_list_db(conn: &Connection, device_id: &str, list_type: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM device_lists WHERE device_id = ?1 AND list_type = ?2",
        params![device_id, list_type],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_device_from_all_lists_db(conn: &Connection, device_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM device_lists WHERE device_id = ?1",
        params![device_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_settings(conn: &Connection, settings: &Settings) -> Result<(), String> {
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)"
    ).map_err(|e| e.to_string())?;
    
    stmt.execute(params!["scan_interval", settings.scan_interval.to_string()]).map_err(|e| e.to_string())?;
    stmt.execute(params!["offline_threshold", settings.offline_threshold.to_string()]).map_err(|e| e.to_string())?;
    stmt.execute(params!["notifications_enabled", settings.notifications_enabled.to_string()]).map_err(|e| e.to_string())?;
    stmt.execute(params!["start_minimized", settings.start_minimized.to_string()]).map_err(|e| e.to_string())?;
    stmt.execute(params!["minimize_to_tray", settings.minimize_to_tray.to_string()]).map_err(|e| e.to_string())?;
    
    Ok(())
}

pub fn save_locations(conn: &Connection, locations: &[Location]) -> Result<(), String> {
    // Clear and re-insert (locations list is small)
    conn.execute("DELETE FROM locations", []).map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare(
        "INSERT INTO locations (id, name, lat, lon, radius_km, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).map_err(|e| e.to_string())?;
    
    for (i, loc) in locations.iter().enumerate() {
        stmt.execute(params![loc.id, loc.name, loc.lat, loc.lon, loc.radius_km, i as i64])
            .map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

pub fn save_app_state(conn: &Connection, data: &StoreData) -> Result<(), String> {
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES (?1, ?2)"
    ).map_err(|e| e.to_string())?;
    
    stmt.execute(params![
        "current_location",
        data.current_location.as_deref().unwrap_or("")
    ]).map_err(|e| e.to_string())?;
    
    if let Some(ref coords) = data.current_coords {
        let coords_json = serde_json::to_string(coords).unwrap_or_default();
        stmt.execute(params!["current_coords", coords_json]).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

// ============================================================
// ACTIVITY LOG OPERATIONS
// ============================================================

pub fn save_activity_log_entry(path: &Path, entry: &ActivityLogEntry) -> Result<i64, String> {
    let conn = Database::open(path)?;
    
    conn.execute(
        "INSERT OR REPLACE INTO activity_log 
         (timestamp, session_id, device_id, device_name, event, status, list_type,
          location_id, location_name, dropouts, duration, summary, end_time,
          last_update, start_time, companions_json, movement_json, activator_json, nearby_unusual_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            entry.timestamp,
            entry.session_id,
            entry.device_id,
            entry.device_name,
            entry.event,
            entry.status,
            entry.list_type,
            entry.location,
            entry.location_name,
            entry.dropouts,
            entry.duration,
            entry.summary,
            entry.end_time,
            entry.last_update,
            entry.start_time,
            entry.companions.as_ref().and_then(|c| serde_json::to_string(c).ok()),
            entry.movement.as_ref().and_then(|m| serde_json::to_string(m).ok()),
            entry.activator.as_ref().and_then(|a| serde_json::to_string(a).ok()),
            entry.nearby_unusual.as_ref().and_then(|n| serde_json::to_string(n).ok()),
        ],
    ).map_err(|e| e.to_string())?;
    
    Ok(conn.last_insert_rowid())
}

pub fn update_activity_log_session(path: &Path, session_id: &str, entry: &ActivityLogEntry) -> Result<(), String> {
    let conn = Database::open(path)?;
    
    conn.execute(
        "UPDATE activity_log SET 
            status = ?1, end_time = ?2, last_update = ?3, duration = ?4, dropouts = ?5,
            summary = ?6, companions_json = ?7, movement_json = ?8, activator_json = ?9,
            location_id = ?10, location_name = ?11
         WHERE session_id = ?12",
        params![
            entry.status,
            entry.end_time,
            entry.last_update,
            entry.duration,
            entry.dropouts,
            entry.summary,
            entry.companions.as_ref().and_then(|c| serde_json::to_string(c).ok()),
            entry.movement.as_ref().and_then(|m| serde_json::to_string(m).ok()),
            entry.activator.as_ref().and_then(|a| serde_json::to_string(a).ok()),
            entry.location,
            entry.location_name,
            session_id,
        ],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

pub fn clear_activity_log_db(path: &Path) -> Result<(), String> {
    let conn = Database::open(path)?;
    conn.execute("DELETE FROM activity_log", []).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_activity_log_db(path: &Path, limit: usize) -> Result<Vec<ActivityLogEntry>, String> {
    let conn = Database::open(path)?;
    
    let mut stmt = conn.prepare(
        "SELECT timestamp, session_id, device_id, device_name, event, status, list_type,
                location_id, location_name, dropouts, duration, summary, end_time, 
                last_update, start_time, companions_json, movement_json, activator_json, nearby_unusual_json
         FROM activity_log 
         ORDER BY timestamp DESC 
         LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(ActivityLogEntry {
            timestamp: row.get(0)?,
            session_id: row.get(1)?,
            device_id: row.get(2)?,
            device_name: row.get(3)?,
            event: row.get(4)?,
            status: row.get(5)?,
            list_type: row.get(6)?,
            location: row.get(7)?,
            location_name: row.get(8)?,
            dropouts: row.get(9)?,
            duration: row.get(10)?,
            summary: row.get(11)?,
            end_time: row.get(12)?,
            last_update: row.get(13)?,
            start_time: row.get(14)?,
            companions: row.get::<_, Option<String>>(15)?
                .and_then(|s| serde_json::from_str(&s).ok()),
            movement: row.get::<_, Option<String>>(16)?
                .and_then(|s| serde_json::from_str(&s).ok()),
            activator: row.get::<_, Option<String>>(17)?
                .and_then(|s| serde_json::from_str(&s).ok()),
            nearby_unusual: row.get::<_, Option<String>>(18)?
                .and_then(|s| serde_json::from_str(&s).ok()),
        })
    }).map_err(|e| e.to_string())?;
    
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    
    // Reverse to chronological order
    entries.reverse();
    Ok(entries)
}

// ============================================================
// RSSI HISTORY OPERATIONS
// ============================================================

pub fn save_rssi_reading(path: &Path, device_id: &str, rssi: i16, timestamp: u64) -> Result<(), String> {
    let conn = Database::open(path)?;
    conn.execute(
        "INSERT INTO rssi_history (device_id, rssi, timestamp) VALUES (?1, ?2, ?3)",
        params![device_id, rssi, timestamp],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_rssi_history_db(path: &Path, device_id: &str, limit: usize) -> Result<Vec<(u64, i16)>, String> {
    let conn = Database::open(path)?;
    let mut stmt = conn.prepare(
        "SELECT timestamp, rssi FROM rssi_history WHERE device_id = ?1 ORDER BY timestamp DESC LIMIT ?2"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map(params![device_id, limit as i64], |row| {
        Ok((row.get::<_, u64>(0)?, row.get::<_, i16>(1)?))
    }).map_err(|e| e.to_string())?;
    
    let mut history = Vec::new();
    for row in rows {
        history.push(row.map_err(|e| e.to_string())?);
    }
    history.reverse();
    Ok(history)
}

// ============================================================
// DEVICE STATS OPERATIONS
// ============================================================

pub fn get_device_stats_db(path: &Path, device_id: &str) -> Result<Option<serde_json::Value>, String> {
    let conn = Database::open(path)?;
    let result = conn.query_row(
        "SELECT device_id, device_name, list_type, total_sessions, total_duration_ms, 
                total_dropouts, first_seen, last_seen, locations_seen 
         FROM device_stats WHERE device_id = ?1",
        params![device_id],
        |row| {
            Ok(serde_json::json!({
                "deviceId": row.get::<_, String>(0)?,
                "deviceName": row.get::<_, String>(1)?,
                "listType": row.get::<_, Option<String>>(2)?,
                "totalSessions": row.get::<_, i64>(3)?,
                "totalDurationMs": row.get::<_, i64>(4)?,
                "totalDropouts": row.get::<_, i64>(5)?,
                "firstSeen": row.get::<_, Option<i64>>(6)?,
                "lastSeen": row.get::<_, Option<i64>>(7)?,
                "locationsSeen": row.get::<_, String>(8)?
            }))
        },
    );
    
    match result {
        Ok(val) => Ok(Some(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn update_device_stats_db(path: &Path, device_id: &str, device_name: &str, 
    list_type: Option<&str>, session_duration_ms: u64, dropouts: u32, 
    first_seen: u64, last_seen: u64, location_name: Option<&str>) -> Result<(), String> {
    
    let conn = Database::open(path)?;
    
    // Get existing or create new
    let existing: Option<(i64, i64, i64, String)> = conn.query_row(
        "SELECT total_sessions, total_duration_ms, total_dropouts, locations_seen FROM device_stats WHERE device_id = ?1",
        params![device_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).ok();
    
    let (new_sessions, new_duration, new_dropouts, mut locations_set) = match existing {
        Some((s, d, dr, l)) => {
            let locs: Vec<String> = serde_json::from_str(&l).unwrap_or_default();
            (s + 1, d + session_duration_ms as i64, dr + dropouts as i64, locs)
        }
        None => (1, session_duration_ms as i64, dropouts as i64, Vec::new()),
    };
    
    if let Some(loc) = location_name {
        if !loc.is_empty() && !locations_set.contains(&loc.to_string()) {
            locations_set.push(loc.to_string());
        }
    }
    
    let locations_json = serde_json::to_string(&locations_set).unwrap_or_else(|_| "[]".to_string());
    
    conn.execute(
        "INSERT OR REPLACE INTO device_stats 
         (device_id, device_name, list_type, total_sessions, total_duration_ms, total_dropouts, first_seen, last_seen, locations_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            device_id, device_name, list_type,
            new_sessions, new_duration, new_dropouts,
            first_seen as i64, last_seen as i64,
            locations_json
        ],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

pub fn get_all_device_stats(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    let conn = Database::open(path)?;
    let mut stmt = conn.prepare(
        "SELECT device_id, device_name, list_type, total_sessions, total_duration_ms, 
                total_dropouts, first_seen, last_seen, locations_seen 
         FROM device_stats ORDER BY total_duration_ms DESC"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "deviceId": row.get::<_, String>(0)?,
            "deviceName": row.get::<_, String>(1)?,
            "listType": row.get::<_, Option<String>>(2)?,
            "totalSessions": row.get::<_, i64>(3)?,
            "totalDurationMs": row.get::<_, i64>(4)?,
            "totalDropouts": row.get::<_, i64>(5)?,
            "firstSeen": row.get::<_, Option<i64>>(6)?,
            "lastSeen": row.get::<_, Option<i64>>(7)?,
            "locationsSeen": row.get::<_, String>(8)?
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut stats = Vec::new();
    for row in rows {
        stats.push(row.map_err(|e| e.to_string())?);
    }
    Ok(stats)
}

// ============================================================
// CLEANUP OPERATIONS
// ============================================================

pub fn cleanup_old_data(path: &Path) -> Result<(), String> {
    let conn = Database::open(path)?;
    let now = chrono::Utc::now().timestamp_millis();
    
    // Delete activity log entries older than 30 days
    let cutoff_30d = now - (30 * 24 * 60 * 60 * 1000i64);
    let deleted_log = conn.execute(
        "DELETE FROM activity_log WHERE timestamp < ?1",
        params![cutoff_30d],
    ).map_err(|e| e.to_string())?;
    
    // Delete RSSI readings older than 7 days
    let cutoff_7d = now - (7 * 24 * 60 * 60 * 1000i64);
    let deleted_rssi = conn.execute(
        "DELETE FROM rssi_history WHERE timestamp < ?1",
        params![cutoff_7d],
    ).map_err(|e| e.to_string())?;
    
    // Keep only last 100 RSSI readings per device
    conn.execute_batch(
        "DELETE FROM rssi_history WHERE rowid NOT IN (
            SELECT rowid FROM rssi_history 
            GROUP BY device_id 
            HAVING rowid IN (
                SELECT rowid FROM rssi_history h2
                WHERE h2.device_id = rssi_history.device_id
                ORDER BY timestamp DESC LIMIT 100
            )
        )"
    ).map_err(|e| e.to_string())?;
    
    if deleted_log > 0 || deleted_rssi > 0 {
        log::info!("Cleanup: removed {} log entries, {} RSSI readings", deleted_log, deleted_rssi);
    }
    
    // Run SQLite VACUUM to reclaim space
    conn.execute_batch("PRAGMA optimize;").ok();
    
    Ok(())
}

// ============================================================
// EXPORT OPERATIONS
// ============================================================

pub fn export_activity_log_csv(path: &Path) -> Result<String, String> {
    let entries = get_activity_log_db(path, 10000)?;
    
    let mut csv = "Timestamp,Device Name,Device ID,Event,Status,Duration (min),Location,Dropouts\n".to_string();
    
    for entry in entries {
        let ts = chrono::DateTime::from_timestamp_millis(entry.timestamp as i64)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        
        let duration_min = entry.duration.map(|d| (d / 60000).to_string()).unwrap_or_default();
        let location = entry.location_name.as_deref().unwrap_or("").replace(',', ";");
        let device_name = entry.device_name.replace(',', ";");
        
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{}\n",
            ts,
            device_name,
            entry.device_id,
            entry.event,
            entry.status.as_deref().unwrap_or(""),
            duration_min,
            location,
            entry.dropouts.unwrap_or(0)
        ));
    }
    
    Ok(csv)
}

// ============================================================
// COMPANION HISTORY OPERATIONS
// ============================================================

pub fn update_companion_db(path: &Path, device_id: &str, companion_id: &str, 
    companion_name: &str, rssi: i16, timestamp: u64) -> Result<(), String> {
    
    let conn = Database::open(path)?;
    
    let existing: Option<(i64, i64, i32)> = conn.query_row(
        "SELECT count, first_seen, avg_rssi FROM companion_history WHERE device_id = ?1 AND companion_id = ?2",
        params![device_id, companion_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).ok();
    
    let (count, first_seen, new_avg_rssi) = match existing {
        Some((c, fs, avg)) => {
            let new_avg = ((avg as i64 * c + rssi as i64) / (c + 1)) as i32;
            (c + 1, fs, new_avg)
        }
        None => (1, timestamp as i64, rssi as i32),
    };
    
    conn.execute(
        "INSERT OR REPLACE INTO companion_history 
         (device_id, companion_id, companion_name, count, first_seen, last_seen, avg_rssi)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![device_id, companion_id, companion_name, count, first_seen, timestamp as i64, new_avg_rssi],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

pub fn get_companions_db(path: &Path, device_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let conn = Database::open(path)?;
    let mut stmt = conn.prepare(
        "SELECT companion_id, companion_name, count, first_seen, last_seen, avg_rssi 
         FROM companion_history WHERE device_id = ?1 ORDER BY count DESC LIMIT 20"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map(params![device_id], |row| {
        Ok(serde_json::json!({
            "companionId": row.get::<_, String>(0)?,
            "companionName": row.get::<_, String>(1)?,
            "count": row.get::<_, i64>(2)?,
            "firstSeen": row.get::<_, i64>(3)?,
            "lastSeen": row.get::<_, i64>(4)?,
            "avgRssi": row.get::<_, i32>(5)?
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut companions = Vec::new();
    for row in rows {
        companions.push(row.map_err(|e| e.to_string())?);
    }
    Ok(companions)
}

// ============================================================
// MIGRATION: Load from JSON file if exists
// ============================================================

pub fn migrate_from_json(json_path: &Path, db_path: &Path) -> Result<(), String> {
    if !json_path.exists() {
        return Ok(());
    }
    
    log::info!("Found legacy JSON store, migrating to SQLite...");
    
    let content = std::fs::read_to_string(json_path)
        .map_err(|e| format!("Failed to read JSON store: {}", e))?;
    
    let data: StoreData = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse JSON store: {}", e))?;
    
    let conn = Database::open(db_path)?;
    Database::init(&conn)?;
    
    // Migrate lists
    save_lists(&conn, &data.lists)?;
    
    // Migrate settings
    save_settings(&conn, &data.settings)?;
    
    // Migrate locations
    save_locations(&conn, &data.locations)?;
    
    // Migrate app state
    save_app_state(&conn, &data)?;
    
    // Migrate activity log
    for entry in &data.activity_log {
        save_activity_log_entry(db_path, entry)?;
    }
    
    // Rename JSON file to .bak
    let bak_path = json_path.with_extension("json.bak");
    std::fs::rename(json_path, bak_path).ok();
    
    log::info!("Migration complete: {} list entries, {} log entries migrated",
        data.lists.whitelist.len() + data.lists.greylist.len() + data.lists.blacklist.len(),
        data.activity_log.len()
    );
    
    Ok(())
}
