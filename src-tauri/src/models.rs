use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::RwLock;
use std::sync::atomic::AtomicBool;
use tokio::sync::broadcast;
use std::path::PathBuf;

// ============================================================
// DEVICE DATA
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub name_source: String,
    pub rssi: i16,
    pub first_seen: u64,
    pub last_seen: u64,
    pub address: String,
    pub is_unknown: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _priority: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceState {
    pub online: bool,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssiReading {
    pub rssi: i16,
    pub timestamp: u64,
}

// ============================================================
// LISTS & SETTINGS
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub name: String,
    pub added_at: u64,
    pub last_seen: Option<u64>,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Lists {
    pub blacklist: HashMap<String, DeviceEntry>,
    pub greylist: HashMap<String, DeviceEntry>,
    pub whitelist: HashMap<String, DeviceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub scan_interval: u64,
    pub offline_threshold: u64,
    pub notifications_enabled: bool,
    pub start_minimized: bool,
    pub minimize_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            scan_interval: 10000,
            offline_threshold: 30000,
            notifications_enabled: true,
            start_minimized: false,
            minimize_to_tray: true,
        }
    }
}

// ============================================================
// LOCATION
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub radius_km: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coords {
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    pub coords: Option<Coords>,
    pub is_unknown: bool,
}

// ============================================================
// ACTIVITY LOG
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionInfo {
    pub device_id: String,
    pub device_name: String,
    pub rssi: i16,
    pub seen_together_count: u32,
    pub is_regular: bool,
    pub is_new: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_greylist: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivatorInfo {
    pub device_id: String,
    pub device_name: String,
    pub rssi: i16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementInfo {
    pub moved: bool,
    pub from_location: String,
    pub to_location: String,
    pub traveled_with: Vec<CompanionInfo>,
    pub left_behind: Vec<CompanionInfo>,
    pub new_companions: Vec<CompanionInfo>,
    pub inferred_movement: bool,
    pub time_since_last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLogEntry {
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub device_id: String,
    pub device_name: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropouts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_update: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub companions: Option<Vec<CompanionInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nearby_unusual: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub movement: Option<MovementInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activator: Option<ActivatorInfo>,
}

// ============================================================
// SESSION TRACKING
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropoutRecord {
    pub offline_at: u64,
    pub duration: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    pub id: String,
    pub start_time: u64,
    pub last_seen: u64,
    pub end_time: Option<u64>,
    pub dropouts: Vec<DropoutRecord>,
    pub location: Option<String>,
    pub location_name: Option<String>,
    pub activator: Option<ActivatorInfo>,
}

// ============================================================
// COMPANION & CO-LOCATION HISTORY
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanionEntry {
    pub count: u32,
    pub first_seen: u64,
    pub last_seen: u64,
    pub avg_rssi: i16,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoLocationEntry {
    pub seen_with: HashMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFootprint {
    pub location_name: Option<String>,
    pub companions: Vec<CompanionInfo>,
    pub device_name: String,
    pub updated_at: u64,
}

// ============================================================
// PERSISTENT STORE DATA
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreData {
    pub lists: Lists,
    pub settings: Settings,
    pub locations: Vec<Location>,
    pub current_location: Option<String>,
    pub current_coords: Option<Coords>,
    pub activity_log: Vec<ActivityLogEntry>,
    pub device_order: Vec<String>,
    pub companion_history: HashMap<String, HashMap<String, CompanionEntry>>,
    pub co_location_history: HashMap<String, CoLocationEntry>,
    pub device_footprints: HashMap<String, DeviceFootprint>,
}

// ============================================================
// AGGREGATED DEVICE VIEW (for frontend)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssiRange {
    pub min: i16,
    pub max: i16,
    pub avg: i16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopDevice {
    pub id: String,
    pub rssi: i16,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceGroup {
    pub id: String,
    pub name: String,
    pub is_group: bool,
    pub group_id: String,
    pub device_count: usize,
    pub random_mac_count: usize,
    pub rssi: i16,
    pub rssi_range: RssiRange,
    pub first_seen: u64,
    pub last_seen: u64,
    pub is_unknown: bool,
    pub name_source: String,
    pub top_devices: Vec<TopDevice>,
    pub _priority: u8,
}

// ============================================================
// SSE MESSAGE (for API server broadcast)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseMessage {
    pub event_type: String,
    pub data: serde_json::Value,
}

// ============================================================
// APP STATE (shared across threads)
// ============================================================

pub struct AppState {
    pub store_path: PathBuf,
    pub store_data: RwLock<StoreData>,
    pub discovered_devices: RwLock<HashMap<String, DeviceInfo>>,
    pub device_states: RwLock<HashMap<String, DeviceState>>,
    pub is_scanning: AtomicBool,
    pub rssi_history: RwLock<HashMap<String, Vec<RssiReading>>>,
    pub active_sessions: RwLock<HashMap<String, ActiveSession>>,
    pub bluetooth_state: RwLock<String>,
    pub sse_tx: broadcast::Sender<SseMessage>,
    pub adapter: RwLock<Option<btleplug::platform::Adapter>>,
    pub companion_history: RwLock<HashMap<String, HashMap<String, CompanionEntry>>>,
    pub co_location_history: RwLock<HashMap<String, HashMap<String, u32>>>,
}

/// Tauri managed state wrapper
pub struct ManagedState(pub std::sync::Arc<AppState>);
