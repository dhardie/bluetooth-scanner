// Tauri API Bridge - provides window.api compatible interface for the renderer

function setupTauriBridge() {
  if (typeof window.__TAURI__ === 'undefined') {
    console.warn('Tauri not detected, will retry...');
    setTimeout(setupTauriBridge, 100);
    return;
  }

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.api = {
    // ============================================================
    // GETTERS
    // ============================================================
    
    async getLists() {
      try { return await invoke('get_lists'); }
      catch(e) { console.error('getLists error:', e); return { blacklist: {}, greylist: {}, whitelist: {} }; }
    },
    
    async getSettings() {
      try { return await invoke('get_settings'); }
      catch(e) { console.error('getSettings error:', e); return { scanInterval: 10000, offlineThreshold: 30000, notificationsEnabled: true }; }
    },
    
    async getActivityLog() {
      try { return await invoke('get_activity_log'); }
      catch(e) { console.error('getActivityLog error:', e); return []; }
    },
    
    async getDiscoveredDevices() {
      try { return await invoke('get_discovered_devices'); }
      catch(e) { console.error('getDiscoveredDevices error:', e); return []; }
    },
    
    async getBluetoothState() {
      try { return await invoke('get_bluetooth_state'); }
      catch(e) { console.error('getBluetoothState error:', e); return 'unknown'; }
    },
    
    async getScanningState() {
      try { return await invoke('get_scanning_state'); }
      catch(e) { console.error('getScanningState error:', e); return false; }
    },
    
    // ============================================================
    // LIST ACTIONS
    // ============================================================
    
    async addToList(deviceId, deviceName, listType) {
      try {
        return await invoke('add_to_list', { device_id: deviceId, device_name: deviceName, list_type: listType });
      } catch(e) {
        console.error('addToList error:', e);
        return await this.getLists();
      }
    },
    
    async removeFromList(deviceId, listType) {
      try {
        return await invoke('remove_from_list', { device_id: deviceId, list_type: listType });
      } catch(e) {
        console.error('removeFromList error:', e);
        return await this.getLists();
      }
    },
    
    async moveToList(deviceId, fromList, toList) {
      try {
        return await invoke('move_to_list', { device_id: deviceId, from_list: fromList, to_list: toList });
      } catch(e) {
        console.error('moveToList error:', e);
        return await this.getLists();
      }
    },
    
    async bulkAddToList(devices, listType) {
      try {
        return await invoke('bulk_add_to_list', { devices, list_type: listType });
      } catch(e) {
        console.error('bulkAddToList error:', e);
        return await this.getLists();
      }
    },
    
    async updateDeviceName(deviceId, name) {
      try {
        return await invoke('update_device_name', { device_id: deviceId, name });
      } catch(e) {
        console.error('updateDeviceName error:', e);
        return await this.getLists();
      }
    },
    
    // ============================================================
    // SETTINGS
    // ============================================================
    
    async updateSettings(settings) {
      try { return await invoke('update_settings', { settings }); }
      catch(e) { console.error('updateSettings error:', e); return settings; }
    },
    
    async clearActivityLog() {
      try { return await invoke('clear_activity_log'); }
      catch(e) { console.error('clearActivityLog error:', e); return []; }
    },
    
    // ============================================================
    // SCANNING
    // ============================================================
    
    async startScanning() {
      try { return await invoke('start_scanning'); }
      catch(e) { console.error('startScanning error:', e); return false; }
    },
    
    async stopScanning() {
      try { return await invoke('stop_scanning'); }
      catch(e) { console.error('stopScanning error:', e); return false; }
    },
    
    // ============================================================
    // LOCATION
    // ============================================================
    
    async getLocations() {
      try { return await invoke('get_locations'); }
      catch(e) { console.error('getLocations error:', e); return []; }
    },
    
    async getCurrentLocation() {
      try { return await invoke('get_current_location'); }
      catch(e) { console.error('getCurrentLocation error:', e); return { id: null, name: null, coords: null, isUnknown: true }; }
    },
    
    async setLocation(locationId) {
      try { return await invoke('set_location', { location_id: locationId }); }
      catch(e) { console.error('setLocation error:', e); return {}; }
    },
    
    async addLocation({ name, lat, lon, radiusKm }) {
      try { return await invoke('add_location', { name, lat, lon, radius_km: radiusKm }); }
      catch(e) { console.error('addLocation error:', e); return { error: e.toString() }; }
    },
    
    async updateLocation({ id, name, lat, lon, radiusKm }) {
      try { return await invoke('update_location', { id, name, lat, lon, radius_km: radiusKm }); }
      catch(e) { console.error('updateLocation error:', e); return await this.getLocations(); }
    },
    
    async removeLocation(locationId) {
      try { return await invoke('remove_location', { location_id: locationId }); }
      catch(e) { console.error('removeLocation error:', e); return await this.getLocations(); }
    },
    
    async refreshLocation() {
      try { return await invoke('refresh_location'); }
      catch(e) { console.error('refreshLocation error:', e); return await this.getCurrentLocation(); }
    },
    
    // ============================================================
    // ANALYTICS & STATS
    // ============================================================
    
    async getDeviceStats(deviceId) {
      try { return await invoke('get_device_stats', { device_id: deviceId }); }
      catch(e) { console.error('getDeviceStats error:', e); return null; }
    },
    
    async getAllDeviceStats() {
      try { return await invoke('get_all_device_stats'); }
      catch(e) { console.error('getAllDeviceStats error:', e); return []; }
    },
    
    async getRssiHistory(deviceId, limit) {
      try { return await invoke('get_rssi_history', { device_id: deviceId, limit }); }
      catch(e) { console.error('getRssiHistory error:', e); return []; }
    },
    
    async getCompanions(deviceId) {
      try { return await invoke('get_companions', { device_id: deviceId }); }
      catch(e) { console.error('getCompanions error:', e); return []; }
    },
    
    async getAnalyticsSummary() {
      try { return await invoke('get_analytics_summary'); }
      catch(e) { console.error('getAnalyticsSummary error:', e); return {}; }
    },
    
    // ============================================================
    // EXPORT
    // ============================================================
    
    async exportActivityLogCsv() {
      try { return await invoke('export_activity_log_csv'); }
      catch(e) { console.error('exportActivityLogCsv error:', e); return ''; }
    },
    
    async exportDevicesJson() {
      try { return await invoke('export_devices_json'); }
      catch(e) { console.error('exportDevicesJson error:', e); return '{}'; }
    },
    
    // ============================================================
    // EVENT LISTENERS (Tauri events)
    // ============================================================
    
    onBluetoothState(callback) {
      listen('bluetooth-state', (event) => callback(event.payload)).catch(console.error);
    },
    
    onScanningState(callback) {
      listen('scanning-state', (event) => callback(event.payload)).catch(console.error);
    },
    
    onDeviceDiscovered(callback) {
      listen('device-discovered', (event) => callback(event.payload)).catch(console.error);
    },
    
    onDeviceBatchUpdate(callback) {
      listen('device-batch-update', (event) => callback(event.payload)).catch(console.error);
    },
    
    onDeviceStatusChange(callback) {
      listen('device-status-change', (event) => callback(event.payload)).catch(console.error);
    },
    
    onActivityLogUpdated(callback) {
      listen('activity-log-updated', (event) => callback(event.payload)).catch(console.error);
    },
    
    onListsUpdated(callback) {
      listen('lists-updated', (event) => callback(event.payload)).catch(console.error);
    },
    
    onLocationChanged(callback) {
      listen('location-changed', (event) => callback(event.payload)).catch(console.error);
    },
    
    onUnknownLocation(callback) {
      listen('unknown-location', (event) => callback(event.payload)).catch(console.error);
    },
    
    onShowAddLocation(callback) {
      listen('show-add-location', (event) => callback(event.payload)).catch(console.error);
    },
    
    onTrayScanToggle(callback) {
      listen('tray-scan-toggle', (event) => callback(event.payload)).catch(console.error);
    }
  };

  console.log('Tauri API bridge initialized successfully');
  window.dispatchEvent(new Event('tauri-bridge-ready'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupTauriBridge);
} else {
  setupTauriBridge();
}
