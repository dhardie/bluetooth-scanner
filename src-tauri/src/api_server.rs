use std::sync::Arc;
use std::convert::Infallible;
use warp::Filter;
use tokio_stream::wrappers::BroadcastStream;
use futures::StreamExt;
use crate::models::{AppState, SseMessage};
use crate::bluetooth;

/// Start the HTTP API server on port 45678.
pub async fn start_api_server(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = warp::any().map(move || state.clone());

    // CORS
    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST", "OPTIONS"])
        .allow_headers(vec!["Content-Type"]);

    // GET /api/devices - Get all discovered devices
    let devices_route = warp::path!("api" / "devices")
        .and(warp::get())
        .and(state.clone())
        .and_then(get_devices);

    // GET /api/lists - Get all device lists
    let lists_route = warp::path!("api" / "lists")
        .and(warp::get())
        .and(state.clone())
        .and_then(get_lists);

    // GET /api/status - Get scanning status
    let status_route = warp::path!("api" / "status")
        .and(warp::get())
        .and(state.clone())
        .and_then(get_status);

    // GET /api/location - Get current location
    let location_route = warp::path!("api" / "location")
        .and(warp::get())
        .and(state.clone())
        .and_then(get_location);

    // GET /api/events - SSE endpoint
    let events_route = warp::path!("api" / "events")
        .and(warp::get())
        .and(state.clone())
        .and_then(sse_events);

    let routes = devices_route
        .or(lists_route)
        .or(status_route)
        .or(location_route)
        .or(events_route)
        .with(cors);

    log::info!("Starting HTTP API server on port 45678");
    warp::serve(routes)
        .run(([127, 0, 0, 1], 45678))
        .await;

    Ok(())
}

async fn get_devices(state: Arc<AppState>) -> Result<impl warp::Reply, Infallible> {
    let devices = bluetooth::get_aggregated_devices(&state).await;
    Ok(warp::reply::json(&devices))
}

async fn get_lists(state: Arc<AppState>) -> Result<impl warp::Reply, Infallible> {
    let data = state.store_data.read().await;
    let lists = data.lists.clone();
    drop(data);
    Ok(warp::reply::json(&lists))
}

async fn get_status(state: Arc<AppState>) -> Result<impl warp::Reply, Infallible> {
    let bt_state = state.bluetooth_state.read().await.clone();
    let is_scanning = state.is_scanning.load(std::sync::atomic::Ordering::SeqCst);
    let device_count = state.discovered_devices.read().await.len();
    
    let data = state.store_data.read().await;
    let whitelist_count = data.lists.whitelist.len();
    let greylist_count = data.lists.greylist.len();
    let blacklist_count = data.lists.blacklist.len();
    drop(data);

    Ok(warp::reply::json(&serde_json::json!({
        "bluetoothState": bt_state,
        "isScanning": is_scanning,
        "deviceCount": device_count,
        "whitelistCount": whitelist_count,
        "greylistCount": greylist_count,
        "blacklistCount": blacklist_count,
        "uptime": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    })))
}

async fn get_location(state: Arc<AppState>) -> Result<impl warp::Reply, Infallible> {
    let data = state.store_data.read().await;
    let loc_id = data.current_location.clone();
    let loc_name = loc_id.as_ref()
        .and_then(|id| data.locations.iter().find(|l| &l.id == id))
        .map(|l| l.name.clone());
    let coords = data.current_coords.clone();
    drop(data);

    Ok(warp::reply::json(&serde_json::json!({
        "id": loc_id,
        "name": loc_name,
        "coords": coords,
        "isUnknown": loc_id.is_none()
    })))
}

async fn sse_events(state: Arc<AppState>) -> Result<impl warp::Reply, Infallible> {
    let rx = state.sse_tx.subscribe();
    let stream = BroadcastStream::new(rx);

    let event_stream = stream.filter_map(|result| async move {
        match result {
            Ok(msg) => {
                let data = serde_json::to_string(&msg.data).unwrap_or_default();
                Some(Ok::<_, Infallible>(warp::sse::Event::default()
                    .event(msg.event_type)
                    .data(data)))
            }
            Err(_) => None,
        }
    });

    Ok(warp::sse::reply(event_stream))
}
