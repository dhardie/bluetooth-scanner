use std::sync::Arc;
use crate::models::{AppState, Coords};
use crate::store;

/// Haversine distance between two lat/lon points in km.
pub fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6371.0_f64;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    r * c
}

/// Fetch approximate coordinates via IP geolocation.
pub async fn get_coordinates() -> Option<Coords> {
    // Try ipapi.co first
    if let Ok(resp) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?
        .get("https://ipapi.co/json/")
        .send()
        .await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let (Some(lat), Some(lon)) = (
                json["latitude"].as_f64(),
                json["longitude"].as_f64(),
            ) {
                return Some(Coords {
                    lat,
                    lon,
                    city: json["city"].as_str().map(String::from),
                    country: json["country_name"].as_str().map(String::from),
                });
            }
        }
    }

    // Fallback to ip-api.com
    if let Ok(resp) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?
        .get("http://ip-api.com/json/")
        .send()
        .await
    {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if json["status"] == "success" {
                if let (Some(lat), Some(lon)) = (
                    json["lat"].as_f64(),
                    json["lon"].as_f64(),
                ) {
                    return Some(Coords {
                        lat,
                        lon,
                        city: json["city"].as_str().map(String::from),
                        country: json["country"].as_str().map(String::from),
                    });
                }
            }
        }
    }

    log::warn!("All geolocation APIs failed");
    None
}

/// Detect current location from GPS coords + saved locations with radius.
pub async fn detect_location(state: &Arc<AppState>, app_handle: &tauri::AppHandle) {
    let coords = match get_coordinates().await {
        Some(c) => c,
        None => {
            log::info!("Geolocation failed, keeping current location");
            return;
        }
    };

    // Update stored coords
    {
        let mut data = state.store_data.write().await;
        data.current_coords = Some(coords.clone());
        if let Err(e) = store::save_store(&state.store_path, &data) {
            log::warn!("Failed to save store after coords update: {}", e);
        }
    }

    // Find best matching location by radius
    let (locations, current_location) = {
        let data = state.store_data.read().await;
        (data.locations.clone(), data.current_location.clone())
    };

    let mut best_match_id: Option<String> = None;
    let mut best_distance = f64::INFINITY;
    let mut best_name = String::new();

    for loc in &locations {
        let distance = haversine_distance(coords.lat, coords.lon, loc.lat, loc.lon);
        let radius = loc.radius_km;
        if distance <= radius && distance < best_distance {
            best_match_id = Some(loc.id.clone());
            best_distance = distance;
            best_name = loc.name.clone();
        }
    }

    let new_location_id = best_match_id.clone();

    if new_location_id != current_location {
        // Location changed – update store
        let mut data = state.store_data.write().await;
        data.current_location = new_location_id.clone();
        let _ = store::save_store(&state.store_path, &data);
        drop(data);

        if let Some(ref id) = new_location_id {
            log::info!("Location auto-detected: {} ({:.1}km)", best_name, best_distance);
            let _ = app_handle.emit(
                "location-changed",
                serde_json::json!({ "id": id, "name": best_name, "distance": best_distance }),
            );
        } else {
            log::info!("Unknown location: {:?}, {:?}", coords.city, coords.country);
            let _ = app_handle.emit(
                "unknown-location",
                serde_json::json!({ "coords": coords }),
            );
        }
    }
}

/// Run location detection on startup then every 5 minutes.
pub async fn detect_location_loop(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    detect_location(&state, &app_handle).await;
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
    loop {
        interval.tick().await;
        detect_location(&state, &app_handle).await;
    }
}
