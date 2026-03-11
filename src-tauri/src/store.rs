use std::path::Path;
use crate::models::StoreData;

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
