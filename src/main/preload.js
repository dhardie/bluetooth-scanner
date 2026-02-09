const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('api', {
  // Getters
  getLists: () => ipcRenderer.invoke('get-lists'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getActivityLog: () => ipcRenderer.invoke('get-activity-log'),
  getDiscoveredDevices: () => ipcRenderer.invoke('get-discovered-devices'),
  getBluetoothState: () => ipcRenderer.invoke('get-bluetooth-state'),
  getScanningState: () => ipcRenderer.invoke('get-scanning-state'),
  
  // List actions
  addToList: (deviceId, deviceName, listType) => 
    ipcRenderer.invoke('add-to-list', { deviceId, deviceName, listType }),
  removeFromList: (deviceId, listType) => 
    ipcRenderer.invoke('remove-from-list', { deviceId, listType }),
  moveToList: (deviceId, fromList, toList) =>
    ipcRenderer.invoke('move-to-list', { deviceId, fromList, toList }),
  bulkAddToList: (devices, listType) =>
    ipcRenderer.invoke('bulk-add-to-list', { devices, listType }),
  updateDeviceName: (deviceId, name) => 
    ipcRenderer.invoke('update-device-name', { deviceId, name }),
  
  // Settings & log
  updateSettings: (settings) => 
    ipcRenderer.invoke('update-settings', settings),
  clearActivityLog: () => 
    ipcRenderer.invoke('clear-activity-log'),
  startScanning: () => 
    ipcRenderer.invoke('start-scanning'),
  stopScanning: () => 
    ipcRenderer.invoke('stop-scanning'),
  
  // Location (GPS/radius-based)
  getLocations: () => ipcRenderer.invoke('get-locations'),
  getCurrentLocation: () => ipcRenderer.invoke('get-current-location'),
  getCurrentCoords: () => ipcRenderer.invoke('get-current-coords'),
  setLocation: (locationId) => ipcRenderer.invoke('set-location', locationId),
  addLocation: (data) => ipcRenderer.invoke('add-location', data),
  updateLocation: (data) => ipcRenderer.invoke('update-location', data),
  removeLocation: (locationId) => ipcRenderer.invoke('remove-location', locationId),
  refreshLocation: () => ipcRenderer.invoke('refresh-location'),
  
  // Event listeners
  onDeviceDiscovered: (callback) => {
    ipcRenderer.on('device-discovered', (event, device) => callback(device));
  },
  onDeviceStatusChange: (callback) => {
    ipcRenderer.on('device-status-change', (event, data) => callback(data));
  },
  onBluetoothState: (callback) => {
    ipcRenderer.on('bluetooth-state', (event, state) => callback(state));
  },
  onScanningState: (callback) => {
    ipcRenderer.on('scanning-state', (event, isScanning) => callback(isScanning));
  },
  onActivityLogUpdated: (callback) => {
    ipcRenderer.on('activity-log-updated', (event, log) => callback(log));
  },
  onListsUpdated: (callback) => {
    ipcRenderer.on('lists-updated', (event, lists) => callback(lists));
  },
  onLocationChanged: (callback) => {
    ipcRenderer.on('location-changed', (event, location) => callback(location));
  },
  onUnknownLocation: (callback) => {
    ipcRenderer.on('unknown-location', (event, data) => callback(data));
  },
  onShowAddLocation: (callback) => {
    ipcRenderer.on('show-add-location', (event) => callback());
  },
  onDeviceBatchUpdate: (callback) => {
    ipcRenderer.on('device-batch-update', (event, updates) => callback(updates));
  }
});
