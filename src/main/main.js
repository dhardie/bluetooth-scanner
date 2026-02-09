const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { initApiServer, updateState: updateApiState, stopApiServer } = require('./apiServer');

// ============================================================
// CRASH & ERROR LOGGING
// ============================================================

// Log directory - use app data path
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const CRASH_LOG = path.join(LOG_DIR, 'crash.log');
const APP_LOG = path.join(LOG_DIR, 'app.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

// Ensure log directory exists
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create log directory:', e);
}

// Rotate log if too large
function rotateLogIfNeeded(logPath) {
  try {
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        const rotatedPath = logPath.replace('.log', `.${Date.now()}.log`);
        fs.renameSync(logPath, rotatedPath);
        // Keep only last 3 rotated logs
        const dir = path.dirname(logPath);
        const baseName = path.basename(logPath, '.log');
        const files = fs.readdirSync(dir)
          .filter(f => f.startsWith(baseName) && f !== path.basename(logPath))
          .sort()
          .reverse();
        files.slice(3).forEach(f => fs.unlinkSync(path.join(dir, f)));
      }
    }
  } catch (e) {
    // Ignore rotation errors
  }
}

// Write to log file
function writeToLog(logPath, level, message, extra = null) {
  try {
    // Ensure log directory exists (recreate if deleted)
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    rotateLogIfNeeded(logPath);
    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${level}] ${message}`;
    if (extra) {
      if (extra instanceof Error) {
        logLine += `\n  Stack: ${extra.stack || extra.message}`;
      } else if (typeof extra === 'object') {
        logLine += `\n  Details: ${JSON.stringify(extra, null, 2)}`;
      } else {
        logLine += `\n  Details: ${extra}`;
      }
    }
    fs.appendFileSync(logPath, logLine + '\n');
  } catch (e) {
    // Last resort - try console (silently fail if that also errors)
    try { console.error('Failed to write to log:', e); } catch (_) {}
  }
}

// Safe logger that won't crash on EPIPE + writes to file
const _log = console.log.bind(console);
const _error = console.error.bind(console);

function safeLog(...args) {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  writeToLog(APP_LOG, 'INFO', message);
  try {
    _log(...args);
  } catch (err) {
    // Ignore EPIPE errors - stdout is gone
  }
}

function safeError(...args) {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  writeToLog(APP_LOG, 'ERROR', message);
  try {
    _error(...args);
  } catch (err) {
    // Ignore EPIPE errors
  }
}

function logCrash(type, error) {
  const message = `${type}: ${error?.message || error}`;
  writeToLog(CRASH_LOG, 'CRASH', message, error);
  safeError(message);
}

// Log startup
writeToLog(APP_LOG, 'INFO', `=== Bluetooth Scanner starting (v${require('../../package.json').version || '1.0.0'}) ===`);
writeToLog(APP_LOG, 'INFO', `Log directory: ${LOG_DIR}`);

// Catch uncaught exceptions - log and try to continue
process.on('uncaughtException', (err) => {
  logCrash('Uncaught exception', err);
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  logCrash('Unhandled rejection', reason);
});

// Electron-specific crash handling
app.on('render-process-gone', (event, webContents, details) => {
  logCrash('Renderer process crashed', { reason: details.reason, exitCode: details.exitCode });
});

app.on('child-process-gone', (event, details) => {
  logCrash('Child process crashed', { type: details.type, reason: details.reason, exitCode: details.exitCode });
});

const { exec } = require('child_process');

// Store for lists and settings
const store = new Store({
  defaults: {
    lists: {
      // Blacklist: completely ignore, don't show in scan results
      blacklist: {},
      // Greylist: log connectivity but no notifications
      greylist: {},
      // Whitelist: full notifications on connect/disconnect
      whitelist: {}
    },
    settings: {
      scanInterval: 10000,  // ms between scans
      offlineThreshold: 30000,  // ms before marking device as offline
      notificationsEnabled: true,
      startMinimized: false,  // Start in menu bar only
      minimizeToTray: true    // Hide to tray when closing window
    },
    // Location configuration (GPS-based with radius)
    locations: [],  // { id, name, lat, lon, radiusKm }
    currentLocation: null,  // id of matched location, or null if unknown
    currentCoords: null,  // { lat, lon } from last geolocation
    activityLog: [],  // { timestamp, deviceId, deviceName, event, list, location }
    deviceOrder: []  // Stable ordering: array of device IDs in discovery order
  }
});

// Current location state
let currentLocation = store.get('currentLocation');
let currentCoords = store.get('currentCoords');

// Haversine formula - calculate distance between two lat/lon points in km
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Get current coordinates via IP geolocation (with fallback)
async function getCoordinates() {
  const https = require('https');
  const http = require('http');
  
  // Try primary API (ipapi.co)
  const tryApi = (url, parseResult) => {
    return new Promise((resolve) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = parseResult(JSON.parse(data));
            if (result) resolve(result);
            else resolve(null);
          } catch (e) {
            safeLog(`Geolocation parse error: ${e.message}`);
            resolve(null);
          }
        });
      });
      req.on('error', (e) => {
        safeLog(`Geolocation request error: ${e.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  };
  
  // Try ipapi.co first
  let result = await tryApi('https://ipapi.co/json/', (json) => {
    if (json.latitude && json.longitude) {
      return { lat: json.latitude, lon: json.longitude, city: json.city, region: json.region, country: json.country_name };
    }
    return null;
  });
  
  if (result) return result;
  
  // Fallback to ip-api.com (different rate limits)
  result = await tryApi('http://ip-api.com/json/', (json) => {
    if (json.lat && json.lon && json.status === 'success') {
      return { lat: json.lat, lon: json.lon, city: json.city, region: json.regionName, country: json.country };
    }
    return null;
  });
  
  if (result) return result;
  
  safeLog('All geolocation APIs failed');
  return null;
}

// Detect location based on GPS coordinates and saved locations with radius
async function detectLocation() {
  const coords = await getCoordinates();
  
  if (!coords) {
    safeLog('Geolocation failed, keeping current location:', currentLocation);
    return currentLocation;
  }
  
  // Store current coordinates
  currentCoords = { lat: coords.lat, lon: coords.lon, city: coords.city, country: coords.country };
  store.set('currentCoords', currentCoords);
  
  const locations = store.get('locations') || [];
  
  // Find location within radius (closest if multiple match)
  let bestMatch = null;
  let bestDistance = Infinity;
  
  for (const loc of locations) {
    if (loc.lat && loc.lon) {
      const distance = haversineDistance(coords.lat, coords.lon, loc.lat, loc.lon);
      const radius = loc.radiusKm || 5; // Default 5km radius
      
      if (distance <= radius && distance < bestDistance) {
        bestMatch = loc;
        bestDistance = distance;
      }
    }
  }
  
  if (bestMatch) {
    if (currentLocation !== bestMatch.id) {
      const oldLocation = currentLocation;
      currentLocation = bestMatch.id;
      store.set('currentLocation', bestMatch.id);
      safeLog(`Location auto-detected: ${bestMatch.name} (${bestDistance.toFixed(1)}km away)`);
      
      // Notify user of location change
      new Notification({
        title: 'Location Changed',
        body: `Now at: ${bestMatch.name}`,
        silent: true
      }).show();
      
      // Notify renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('location-changed', { 
          id: bestMatch.id, 
          name: bestMatch.name,
          distance: bestDistance 
        });
      }
    }
    return bestMatch.id;
  }
  
  // No matching location - we're somewhere new
  if (currentLocation !== null) {
    safeLog(`Unknown location: ${coords.city}, ${coords.country} - no saved location within radius`);
    currentLocation = null;
    store.set('currentLocation', null);
    
    // Notify renderer about unknown location
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('unknown-location', { coords, city: coords.city, country: coords.country });
    }
  }
  
  return null;
}

let mainWindow = null;
let tray = null;
let noble = null;
let scanInterval = null;
let discoveredDevices = new Map();  // Current scan cycle discoveries
let deviceStates = new Map();  // uuid -> { online: boolean, lastSeen: timestamp }

// ═══ Phase 2: Companion Fingerprinting ═══
// Tracks which devices are consistently seen near whitelisted devices
// companionHistory[whitelistedId] = { deviceId: { count, lastSeen, avgRssi, name } }
let companionHistory = {};

// ═══ Phase 3: Proximity Tracking ═══
// Tracks RSSI over time for whitelisted devices to detect movement
// rssiHistory[deviceId] = [{ rssi, timestamp }] (last 30 readings)
let rssiHistory = {};

// Throttle renderer updates to prevent IPC flood
let pendingDeviceUpdates = new Map();  // Batch device updates
let rendererFlushTimer = null;
const RENDERER_FLUSH_INTERVAL = 1000; // Send updates to renderer at most once per second

function scheduleRendererFlush() {
  if (rendererFlushTimer) return;
  rendererFlushTimer = setTimeout(() => {
    rendererFlushTimer = null;
    flushRendererUpdates();
  }, RENDERER_FLUSH_INTERVAL);
}

function flushRendererUpdates() {
  if (pendingDeviceUpdates.size === 0) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingDeviceUpdates.clear();
    return;
  }
  
  pendingDeviceUpdates.clear();
  
  // Send AGGREGATED data instead of raw updates
  // This collapses 1000+ Apple/Unknown devices into ~5 group summaries
  try {
    const aggregated = getAggregatedDevices();
    mainWindow.webContents.send('device-batch-update', aggregated);
  } catch (err) {
    // Window may have been destroyed between check and send
  }
  
  // Refresh companion data on active activity sessions
  // (phones may connect after the whitelisted device came online)
  refreshActiveSessionCompanions();
}

// Periodically update companion lists on active activity sessions
function refreshActiveSessionCompanions() {
  if (activeSessions.size === 0) return;
  
  const log = store.get('activityLog') || [];
  let changed = false;
  
  for (const [deviceId, session] of activeSessions.entries()) {
    if (session.endTime) continue; // Not active
    
    const companions = findNearbyCompanions(deviceId);
    const entry = log.find(e => e.sessionId === session.id);
    if (!entry) continue;
    
    // Update companions on the entry
    const oldCount = (entry.companions || []).length;
    const newCount = companions.length;
    
    if (newCount > 0 || oldCount > 0) {
      entry.companions = companions.length > 0 ? companions : undefined;
      entry.lastUpdate = Date.now();
      changed = true;
    }
  }
  
  if (changed) {
    store.set('activityLog', log);
    broadcastActivityUpdate(null, log);
  }
}

function createWindow() {
  const settings = store.get('settings');
  
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    show: false,
    skipTaskbar: settings.startMinimized  // Hide from dock if starting minimized
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  
  mainWindow.once('ready-to-show', () => {
    // Only show if not starting minimized
    if (!settings.startMinimized) {
      mainWindow.show();
    }
  });

  mainWindow.on('close', (event) => {
    const settings = store.get('settings');
    if (!app.isQuitting && settings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      // Hide from dock when minimized to tray
      if (process.platform === 'darwin') {
        app.dock.hide();
      }
    }
  });
  
  mainWindow.on('show', () => {
    // Show in dock when window is visible
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADwSURBVDiNpZMxDoJAEEX/bGxMLKyNhYUH8AYewBN4Aw/gCTyBhQfwBtQWxgNoobGwsKO2IqOFLLIsS+In08zO/DeTnQECVABPAPf4/cVYDyTABugLugXOYPYNUAHcAN3QJZJ3V4BWYiB5cwnYRWuJ/MpJIJMYSA7FWrIvSUlPsgvcAB/HWp6SEvnxlJTnAp0kBoL7GZIT4fJKkoL7SSLJhYzJGvgGNED7E7ACTgNz9IJvJQY8lwDYBkqABLiJ5V4iAcdAAzAFdpKYSA5lZ5I4bJQsm0kCkncDScRNsgLGUlKSHAqynuQZ+ASegRbwATlVaHGUIi1FAAAAAElFTkSuQmCC'
  );
  
  tray = new Tray(icon);
  updateTrayMenu();
  
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu() {
  const locations = store.get('locations') || [];
  const currentLoc = currentLocation ? locations.find(l => l.id === currentLocation) : null;
  const locName = currentLoc?.name || (currentCoords ? `${currentCoords.city || 'Unknown'}, ${currentCoords.country || ''}` : 'Unknown');
  
  // Build location submenu
  const locationSubmenu = locations.length > 0 ? locations.map(loc => ({
    label: `${loc.name} (${loc.radiusKm || 5}km)`,
    type: 'radio',
    checked: loc.id === currentLocation,
    click: () => {
      currentLocation = loc.id;
      store.set('currentLocation', loc.id);
      updateTrayMenu();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('location-changed', { id: loc.id, name: loc.name });
      }
    }
  })) : [{ label: 'No locations saved', enabled: false }];
  
  // Add "Save Current Location" option if we have coords
  if (currentCoords) {
    locationSubmenu.push({ type: 'separator' });
    locationSubmenu.push({
      label: '➕ Save Current Location...',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('show-add-location');
        }
      }
    });
  }
  
  const coordsLabel = currentCoords 
    ? `🌍 ${currentCoords.lat?.toFixed(3)}, ${currentCoords.lon?.toFixed(3)}`
    : '🌍 No coordinates';
  
  const contextMenu = Menu.buildFromTemplate([
    { label: `📍 ${locName}`, enabled: false },
    { label: coordsLabel, enabled: false },
    { type: 'separator' },
    { label: 'Locations', submenu: locationSubmenu },
    { label: '🔄 Refresh Location', click: async () => { await detectLocation(); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Open Scanner', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Start Scanning', click: () => startScanning() },
    { label: 'Stop Scanning', click: () => stopScanning() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  
  tray.setToolTip(`Bluetooth Scanner - ${locName}`);
  tray.setContextMenu(contextMenu);
}

async function initBluetooth() {
  try {
    noble = require('@abandonware/noble');
    
    noble.on('stateChange', (state) => {
      safeLog('Bluetooth state:', state);
      if (mainWindow) {
        mainWindow.webContents.send('bluetooth-state', state);
      }
      
      if (state === 'poweredOn') {
        startScanning();
      } else {
        stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      handleDeviceDiscovered(peripheral);
    });

    safeLog('Bluetooth initialized');
  } catch (err) {
    safeError('Failed to initialize Bluetooth:', err);
  }
}

function getDeviceList(listType) {
  const lists = store.get('lists');
  return lists[listType] || {};
}

function isInList(deviceId, listType) {
  const list = getDeviceList(listType);
  return !!list[deviceId];
}

function isBlacklisted(deviceId) {
  return isInList(deviceId, 'blacklist');
}

function getDeviceListType(deviceId) {
  const lists = store.get('lists');
  if (lists.blacklist[deviceId]) return 'blacklist';
  if (lists.greylist[deviceId]) return 'greylist';
  if (lists.whitelist[deviceId]) return 'whitelist';
  return null;
}

// Common manufacturer prefixes (OUI - first 3 bytes of MAC)
const OUI_MANUFACTURERS = {
  'ac:de:48': 'Apple', 'f0:db:f8': 'Apple', '3c:06:30': 'Apple', '14:98:77': 'Apple',
  '00:1a:7d': 'Samsung', 'cc:07:ab': 'Samsung', '8c:f5:a3': 'Samsung', '00:26:5f': 'Samsung',
  '00:1e:c2': 'Apple', 'a8:51:5b': 'Apple', '00:03:93': 'Apple', 'e4:c6:3d': 'Apple',
  'b8:27:eb': 'Raspberry Pi', 'dc:a6:32': 'Raspberry Pi', 'e4:5f:01': 'Raspberry Pi',
  '58:cb:52': 'Google', 'f4:f5:d8': 'Google', '54:60:09': 'Google',
  'f8:a2:d6': 'Amazon', 'f0:f0:a4': 'Amazon', '74:c2:46': 'Amazon',
  '98:d3:31': 'Sony', '00:1d:ba': 'Sony', 'ac:89:95': 'Sony',
  'fc:a1:83': 'Bose', '04:52:c7': 'Bose', '08:df:1f': 'Bose',
  '00:1b:66': 'JBL', 'b8:f6:53': 'JBL', 'ac:12:2f': 'JBL',
  '00:02:5b': 'Logitech', '00:1f:20': 'Logitech', '6c:b7:f4': 'Logitech',
  '00:25:db': 'Tile', '00:21:4f': 'Tile',
  '00:07:80': 'Ring', 'f4:b8:5e': 'Ring'
};

// Service UUID to device type hints
const SERVICE_TYPE_HINTS = {
  '180f': 'Battery', '180a': 'Device Info', '1812': 'HID', '1803': 'Link Loss',
  '181c': 'User Data', '181d': 'Weight', '1810': 'Blood Pressure', '180d': 'Heart Rate',
  '1816': 'Cycling', '1818': 'Cycling Power', '181a': 'Environment', '1809': 'Health Thermo',
  'febe': 'Bose', 'fe9f': 'Google', 'fd6f': 'Exposure Notify'
};

function inferDeviceName(peripheral) {
  // Try to get name from advertisement
  const advName = peripheral.advertisement?.localName || peripheral.name;
  if (advName && advName !== 'Unknown' && !advName.match(/^[0-9a-f-]+$/i)) {
    return { name: advName, source: 'advertised' };
  }
  
  // Try manufacturer from MAC address OUI
  const address = (peripheral.address || '').toLowerCase();
  if (address && address !== 'unknown') {
    const oui = address.substring(0, 8);
    const manufacturer = OUI_MANUFACTURERS[oui];
    if (manufacturer) {
      // Try to get more specific with service UUIDs
      const serviceUUIDs = peripheral.advertisement?.serviceUuids || [];
      let deviceType = '';
      for (const uuid of serviceUUIDs) {
        const hint = SERVICE_TYPE_HINTS[uuid.toLowerCase().replace(/-/g, '').substring(0, 4)];
        if (hint) {
          deviceType = hint;
          break;
        }
      }
      const suffix = address.slice(-5).replace(':', '').toUpperCase();
      return { 
        name: deviceType ? `${manufacturer} ${deviceType} (${suffix})` : `${manufacturer} Device (${suffix})`,
        source: 'oui' 
      };
    }
  }
  
  // Check manufacturer data
  const manufacturerData = peripheral.advertisement?.manufacturerData;
  if (manufacturerData) {
    // Apple devices have company ID 0x004C (76)
    if (manufacturerData.length >= 2) {
      const companyId = manufacturerData.readUInt16LE(0);
      if (companyId === 76) return { name: `Apple Device`, source: 'manufacturer' };
      if (companyId === 6) return { name: `Microsoft Device`, source: 'manufacturer' };
      if (companyId === 117) return { name: `Samsung Device`, source: 'manufacturer' };
      if (companyId === 224) return { name: `Google Device`, source: 'manufacturer' };
    }
  }
  
  return { name: 'Unknown Device', source: 'none' };
}

function handleDeviceDiscovered(peripheral) {
  const deviceId = peripheral.uuid || peripheral.id;
  const { name: deviceName, source: nameSource } = inferDeviceName(peripheral);
  const rssi = peripheral.rssi;
  
  // Skip blacklisted devices entirely
  if (isBlacklisted(deviceId)) {
    return;
  }
  
  // Track discovery order (stable ordering, capped at 500)
  let deviceOrder = store.get('deviceOrder') || [];
  if (!deviceOrder.includes(deviceId)) {
    deviceOrder.push(deviceId);
    // Cap at 500 to prevent unbounded growth (was 6700+ and causing UI lockup)
    if (deviceOrder.length > 500) {
      deviceOrder = deviceOrder.slice(-500);
    }
    store.set('deviceOrder', deviceOrder);
  }
  
  // Preserve firstSeen from existing device data
  const existingDevice = discoveredDevices.get(deviceId);
  const now = Date.now();
  
  const deviceInfo = {
    id: deviceId,
    name: deviceName,
    nameSource: nameSource,
    rssi: rssi,
    firstSeen: existingDevice?.firstSeen || now,
    lastSeen: now,
    address: peripheral.address || 'unknown',
    isUnknown: nameSource === 'none',
    listType: getDeviceListType(deviceId)
  };
  
  discoveredDevices.set(deviceId, deviceInfo);
  
  // Check if device is in whitelist or greylist
  const listType = getDeviceListType(deviceId);
  if (listType === 'whitelist' || listType === 'greylist') {
    const wasOnline = deviceStates.get(deviceId)?.online || false;
    
    // Only log state transitions, not every discover event
    if (!wasOnline) {
      safeLog(`[TRACK] Device ${deviceName} (${deviceId.slice(0,8)}) on ${listType}, came online`);
    }
    
    // Update state
    deviceStates.set(deviceId, { online: true, lastSeen: Date.now() });
    
    // Update list entry
    const lists = store.get('lists');
    if (lists[listType][deviceId]) {
      lists[listType][deviceId].lastSeen = Date.now();
      lists[listType][deviceId].online = true;
      store.set('lists', lists);
    }
    
    // Notify if just came online (whitelist only for notifications)
    if (!wasOnline) {
      safeLog(`[TRACK] Calling notifyDeviceOnline for ${deviceName}`);
      notifyDeviceOnline(deviceId, lists[listType][deviceId]?.name || deviceName, listType);
    }
  }
  
  // ═══ Phase 3: Track RSSI history for proximity detection ═══
  if (!rssiHistory[deviceId]) rssiHistory[deviceId] = [];
  rssiHistory[deviceId].push({ rssi, timestamp: Date.now() });
  // Keep last 30 readings
  if (rssiHistory[deviceId].length > 30) {
    rssiHistory[deviceId] = rssiHistory[deviceId].slice(-30);
  }
  
  // ═══ Phase 2: Record companion snapshot for whitelisted devices ═══
  if (listType === 'whitelist' || listType === 'greylist') {
    recordCompanionSnapshot(deviceId);
  }
  
  // Queue for batched renderer update (prevents IPC flood)
  pendingDeviceUpdates.set(deviceId, deviceInfo);
  scheduleRendererFlush();
  
  // Broadcast to API clients (also throttled - only if data meaningfully changed)
  if (global.broadcastEvent) {
    global.broadcastEvent('device', deviceInfo);
  }
}

function startScanning() {
  if (!noble || noble.state !== 'poweredOn') {
    safeLog('Cannot start scanning - Bluetooth not ready');
    return;
  }
  
  safeLog('Starting Bluetooth scan...');
  isScanning = true;
  
  // Don't clear devices - keep stable list
  // discoveredDevices.clear();
  
  noble.startScanning([], true);
  
  if (scanInterval) clearInterval(scanInterval);
  
  const settings = store.get('settings');
  scanInterval = setInterval(() => {
    checkOfflineDevices();
  }, settings.scanInterval);
  
  if (mainWindow) {
    mainWindow.webContents.send('scanning-state', true);
  }
  
  // Broadcast to API clients
  if (global.broadcastEvent) {
    global.broadcastEvent('scanning', { scanning: true });
    updateApiState({ isScanning: true });
  }
}

function stopScanning() {
  if (noble) {
    noble.stopScanning();
  }
  isScanning = false;
  
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  
  if (mainWindow) {
    mainWindow.webContents.send('scanning-state', false);
  }
  
  // Broadcast to API clients
  if (global.broadcastEvent) {
    global.broadcastEvent('scanning', { scanning: false });
    updateApiState({ isScanning: false });
  }
  
  safeLog('Scanning stopped');
}

function checkOfflineDevices() {
  const lists = store.get('lists');
  const settings = store.get('settings');
  const now = Date.now();
  
  // Check both whitelist and greylist
  for (const listType of ['whitelist', 'greylist']) {
    for (const [deviceId, info] of Object.entries(lists[listType])) {
      const state = deviceStates.get(deviceId);
      const lastSeen = state?.lastSeen || info.lastSeen || 0;
      const wasOnline = state?.online || false;
      
      if (wasOnline && (now - lastSeen) > settings.offlineThreshold) {
        // Device went offline
        deviceStates.set(deviceId, { online: false, lastSeen: lastSeen });
        
        lists[listType][deviceId].online = false;
        store.set('lists', lists);
        
        notifyDeviceOffline(deviceId, info.name, listType);
      }
    }
  }
}

// Generic device names that shouldn't get their own activity log entries
const GENERIC_DEVICE_NAMES = ['Apple Device', 'Unknown Device', 'Samsung Device', 'Google Device', 'Microsoft Device'];

function notifyDeviceOnline(deviceId, deviceName, listType) {
  const settings = store.get('settings');
  const isGeneric = GENERIC_DEVICE_NAMES.includes(deviceName);
  
  // Find unusual nearby devices before logging
  const nearbyUnusual = findUnusualNearby(deviceId);
  
  // Find ALL nearby companions (phones etc.) to show who's using this device
  const nearbyCompanions = findNearbyCompanions(deviceId);
  
  // Update co-location pairs for all currently online devices
  updateCoLocationPairs(deviceId);
  
  // Detect movement — compare current location + companions with last footprint
  const locInfo = (store.get('locations') || []).find(l => l.id === currentLocation);
  const currentLocationName = locInfo?.name || currentLocation;
  const movement = detectMovement(deviceId, currentLocationName, nearbyCompanions);
  
  // Save current footprint for next comparison
  saveDeviceFootprint(deviceId, {
    locationName: currentLocationName,
    companions: nearbyCompanions,
    deviceName
  });
  
  // Only log activity for named devices — generic devices appear as companions only
  if (!isGeneric) {
    logActivity(deviceId, deviceName, 'online', listType, nearbyUnusual.length > 0 ? nearbyUnusual : null, nearbyCompanions.length > 0 ? nearbyCompanions : null, movement);
  }
  
  if (nearbyUnusual.length > 0) {
    safeLog(`[CO-LOCATION] ${deviceName} online with ${nearbyUnusual.length} unusual nearby: ${nearbyUnusual.map(d => `${d.deviceName} (${d.rssi} dBm, seen ${d.seenTogetherCount}x)`).join(', ')}`);
  }
  
  // Only show notification for whitelist
  if (listType === 'whitelist' && settings.notificationsEnabled) {
    let notifBody = `${deviceName} is now in range`;
    if (nearbyUnusual.length > 0) {
      notifBody += `\n👀 Unusual nearby: ${nearbyUnusual.map(d => d.deviceName).join(', ')}`;
    }
    new Notification({
      title: 'Device Online',
      body: notifBody,
      silent: true
    }).show();
  }
  
  if (mainWindow) {
    mainWindow.webContents.send('device-status-change', { deviceId, deviceName, status: 'online', listType });
  }
}

function notifyDeviceOffline(deviceId, deviceName, listType) {
  const settings = store.get('settings');
  const isGeneric = GENERIC_DEVICE_NAMES.includes(deviceName);
  
  // Save footprint on offline — captures last known companions + location
  const lastCompanions = findNearbyCompanions(deviceId);
  const locInfo = (store.get('locations') || []).find(l => l.id === currentLocation);
  saveDeviceFootprint(deviceId, {
    locationName: locInfo?.name || currentLocation,
    companions: lastCompanions,
    deviceName
  });
  
  // Only log activity for named devices — generic devices appear as companions only
  if (!isGeneric) {
    logActivity(deviceId, deviceName, 'offline', listType);
  }
  
  // Only show notification for whitelist
  if (listType === 'whitelist' && settings.notificationsEnabled) {
    new Notification({
      title: 'Device Offline',
      body: `${deviceName} is no longer in range`,
      silent: true
    }).show();
  }
  
  if (mainWindow) {
    mainWindow.webContents.send('device-status-change', { deviceId, deviceName, status: 'offline', listType });
  }
}

// ============================================================
// PROXIMITY CO-LOCATION TRACKING
// ============================================================

// Get or initialize co-location history from store
function getCoLocationHistory() {
  return store.get('coLocationHistory') || {};
}

function saveCoLocationHistory(history) {
  store.set('coLocationHistory', history);
}

// Update co-location history: increment counts for all online device pairs
function updateCoLocationPairs(triggerDeviceId) {
  const history = getCoLocationHistory();
  const onlineDeviceIds = [];

  // Collect all currently online devices
  for (const [devId, state] of deviceStates.entries()) {
    if (state.online) {
      onlineDeviceIds.push(devId);
    }
  }

  // For each pair of online devices, increment their co-location count
  for (let i = 0; i < onlineDeviceIds.length; i++) {
    for (let j = i + 1; j < onlineDeviceIds.length; j++) {
      const a = onlineDeviceIds[i];
      const b = onlineDeviceIds[j];

      // Ensure both directions exist
      if (!history[a]) history[a] = { seenWith: {} };
      if (!history[b]) history[b] = { seenWith: {} };

      history[a].seenWith[b] = Math.min((history[a].seenWith[b] || 0) + 1, 100);
      history[b].seenWith[a] = Math.min((history[b].seenWith[a] || 0) + 1, 100);
    }
  }

  saveCoLocationHistory(history);
}

// Find unusual nearby devices when a whitelisted device comes online
function findUnusualNearby(triggerDeviceId) {
  const history = getCoLocationHistory();
  const deviceHistory = history[triggerDeviceId]?.seenWith || {};
  const nearbyUnusual = [];

  // Gather all currently online devices with their RSSI
  for (const [devId, state] of deviceStates.entries()) {
    if (!state.online || devId === triggerDeviceId) continue;

    const deviceInfo = discoveredDevices.get(devId);
    if (!deviceInfo) continue;

    const rssi = deviceInfo.rssi;
    // Only include devices with RSSI > -80 (reasonably close)
    if (rssi === undefined || rssi === null || rssi <= -80) continue;

    const seenTogetherCount = deviceHistory[devId] || 0;
    // Only flag unusual (seen together fewer than 5 times)
    if (seenTogetherCount >= 5) continue;

    nearbyUnusual.push({
      deviceId: devId,
      deviceName: deviceInfo.name || 'Unknown Device',
      rssi: rssi,
      seenTogetherCount: seenTogetherCount
    });
  }

  // Sort by RSSI (strongest/closest first) and limit to 3
  nearbyUnusual.sort((a, b) => b.rssi - a.rssi);
  return nearbyUnusual.slice(0, 3);
}

// Find ALL nearby devices (companions) for a whitelisted/greylisted device
// Returns devices sorted by signal strength, labelled as regular/new
function findNearbyCompanions(triggerDeviceId, options = {}) {
  const { 
    closeProximityOnly = false,  // If true, use stricter RSSI threshold (-65 vs -75)
    includeGreylist = true       // Include greylist devices (phones, watches)
  } = options;
  
  const history = getCoLocationHistory();
  const deviceHistory = history[triggerDeviceId]?.seenWith || {};
  const companions = [];
  const lists = store.get('lists');
  
  // RSSI threshold: -65 for "very close" (within ~1-2m), -75 for "nearby"
  const rssiThreshold = closeProximityOnly ? -65 : -75;

  for (const [devId, state] of deviceStates.entries()) {
    if (!state.online || devId === triggerDeviceId) continue;
    
    // Skip blacklisted devices — not relevant
    if (lists.blacklist[devId]) continue;
    
    // Skip other whitelisted devices — they're tracked items, not users
    if (lists.whitelist[devId]) continue;
    
    // Include greylist devices — these are phones, watches, laptops (user devices)
    // This is the key fix: greylist devices ARE potential companions
    const isGreylist = !!lists.greylist[devId];
    if (!includeGreylist && isGreylist) continue;

    const deviceInfo = discoveredDevices.get(devId);
    if (!deviceInfo) continue;

    const rssi = deviceInfo.rssi;
    // Only include devices with strong enough signal
    if (rssi === undefined || rssi === null || rssi <= rssiThreshold) continue;

    const seenTogetherCount = deviceHistory[devId] || 0;
    const proximity = getProximityInfo(devId);

    companions.push({
      deviceId: devId,
      deviceName: deviceInfo.name || 'Unknown Device',
      rssi,
      seenTogetherCount,
      isRegular: seenTogetherCount >= 5,
      isNew: seenTogetherCount === 0,
      distance: proximity?.distance || null,
      listType: getDeviceListType(devId),
      isGreylist
    });
  }

  // Sort: named devices first, then greylist, then by RSSI (closest first)
  companions.sort((a, b) => {
    // Named devices before "Unknown Device" or "Apple Device"
    const aGeneric = (a.deviceName === 'Unknown Device' || a.deviceName === 'Apple Device') ? 1 : 0;
    const bGeneric = (b.deviceName === 'Unknown Device' || b.deviceName === 'Apple Device') ? 1 : 0;
    if (aGeneric !== bGeneric) return aGeneric - bGeneric;
    // Then by signal strength (closest first)
    return b.rssi - a.rssi;
  });

  return companions.slice(0, 8); // Cap at 8 companion devices
}

// Daily decay: reduce all co-location counts by 1 every 24 hours
let coLocationDecayTimer = null;
function startCoLocationDecay() {
  // Run every 24 hours
  coLocationDecayTimer = setInterval(() => {
    const history = getCoLocationHistory();
    let changed = false;

    for (const devId of Object.keys(history)) {
      const seenWith = history[devId].seenWith;
      for (const otherId of Object.keys(seenWith)) {
        if (seenWith[otherId] > 0) {
          seenWith[otherId]--;
          changed = true;
          // Clean up zero entries
          if (seenWith[otherId] <= 0) {
            delete seenWith[otherId];
          }
        }
      }
      // Clean up empty device entries
      if (Object.keys(seenWith).length === 0) {
        delete history[devId];
      }
    }

    if (changed) {
      saveCoLocationHistory(history);
      safeLog('[CO-LOCATION] Daily decay applied to co-location history');
    }
  }, 24 * 60 * 60 * 1000);
}

// ============================================================
// SMART ACTIVITY LOGGING - Aggregated, Human-Readable
// ============================================================

// Track active sessions for aggregation
const activeSessions = new Map(); // deviceId -> { startTime, lastSeen, dropouts: [] }
const FLAP_THRESHOLD_MS = 60000;  // 1 minute - if back online within this, count as flap
const FLAP_COUNT_THRESHOLD = 3;   // This many rapid reconnects = "unstable"

// ═══ Movement Detection ═══
// Stores last-known location + companions for each whitelisted device
// When a device comes back online, we compare to detect movement
function getDeviceFootprints() {
  return store.get('deviceFootprints') || {};
}

function saveDeviceFootprint(deviceId, footprint) {
  const footprints = getDeviceFootprints();
  footprints[deviceId] = {
    ...footprint,
    updatedAt: Date.now()
  };
  store.set('deviceFootprints', footprints);
}

/**
 * Detect if a device has moved since it was last seen.
 * Compares current location + companions with stored footprint.
 * Returns { moved: bool, fromLocation, toLocation, traveledWith: [], leftBehind: [], newCompanions: [] }
 */
function detectMovement(deviceId, currentLocationName, currentCompanions) {
  const footprints = getDeviceFootprints();
  const lastFootprint = footprints[deviceId];
  
  if (!lastFootprint) {
    // First time seeing this device — no movement to detect
    return null;
  }
  
  const result = {
    moved: false,
    fromLocation: lastFootprint.locationName || 'Unknown',
    toLocation: currentLocationName || 'Unknown',
    traveledWith: [],    // Companions that were at old location AND are here now
    leftBehind: [],      // Companions at old location but NOT here now
    newCompanions: [],   // Companions here now but NOT at old location
    timeSinceLastSeen: Date.now() - (lastFootprint.updatedAt || 0)
  };
  
  // Location change detection
  if (lastFootprint.locationName && currentLocationName && 
      lastFootprint.locationName !== currentLocationName) {
    result.moved = true;
  }
  
  // Companion comparison — even without location change, track who's with the device
  const oldCompanionIds = new Set((lastFootprint.companions || []).map(c => c.deviceId));
  const newCompanionIds = new Set((currentCompanions || []).map(c => c.deviceId));
  const newCompanionMap = new Map((currentCompanions || []).map(c => [c.deviceId, c]));
  const oldCompanionMap = new Map((lastFootprint.companions || []).map(c => [c.deviceId, c]));
  
  // Traveled with: present in both old and new
  for (const id of oldCompanionIds) {
    if (newCompanionIds.has(id)) {
      result.traveledWith.push(newCompanionMap.get(id) || oldCompanionMap.get(id));
    }
  }
  
  // Left behind: in old but not in new
  for (const id of oldCompanionIds) {
    if (!newCompanionIds.has(id)) {
      result.leftBehind.push(oldCompanionMap.get(id));
    }
  }
  
  // New companions: in new but not in old
  for (const id of newCompanionIds) {
    if (!oldCompanionIds.has(id)) {
      result.newCompanions.push(newCompanionMap.get(id));
    }
  }
  
  // If companions changed significantly, flag as potential movement even without location data
  if (!result.moved && result.timeSinceLastSeen > 300000) { // >5 min offline
    const totalOld = oldCompanionIds.size;
    const totalNew = newCompanionIds.size;
    const overlap = result.traveledWith.length;
    // If >50% of companions changed, might have moved
    if (totalOld > 0 && totalNew > 0 && overlap < Math.min(totalOld, totalNew) * 0.5) {
      result.moved = true;
      result.inferredMovement = true; // Movement inferred from companion change, not GPS
    }
  }
  
  return result;
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function logActivity(deviceId, deviceName, event, listType, nearbyUnusual, nearbyCompanions, movement) {
  try {
    safeLog(`[ACTIVITY] Event: ${deviceName} ${event} (${listType})`);
    const log = store.get('activityLog') || [];
    const locations = store.get('locations') || [];
    const locInfo = locations.find(l => l.id === currentLocation);
    const now = Date.now();
    
    if (event === 'online') {
      // Check if this is a quick reconnect (flapping)
      const session = activeSessions.get(deviceId);
      
      if (session && session.endTime && (now - session.endTime) < FLAP_THRESHOLD_MS) {
        // Quick reconnect - this is a flap/dropout, not a new session
        session.dropouts.push({
          offlineAt: session.endTime,
          duration: now - session.endTime
        });
        session.endTime = null;
        session.lastSeen = now;
        safeLog(`[ACTIVITY] Flap detected for ${deviceName} (${session.dropouts.length} dropouts)`);
        
        // Update the existing log entry if it's recent
        const recentEntry = log.find(e => e.deviceId === deviceId && e.sessionId === session.id);
        if (recentEntry) {
          recentEntry.dropouts = session.dropouts.length;
          recentEntry.lastUpdate = now;
          recentEntry.status = session.dropouts.length >= FLAP_COUNT_THRESHOLD ? 'unstable' : 'online';
          recentEntry.summary = buildSessionSummary(session, deviceName, true);
          store.set('activityLog', log);
          broadcastActivityUpdate(recentEntry, log);
        }
        return;
      }
      
      // New session starting
      const sessionId = `sess-${now}-${deviceId.slice(0, 6)}`;
      
      // Find the ACTIVATOR: the closest device (very close proximity) when this device turned on
      // This tells us WHO turned on the device
      const closeCompanions = findNearbyCompanions(deviceId, { closeProximityOnly: true, includeGreylist: true });
      const activator = closeCompanions.length > 0 ? closeCompanions[0] : null;
      
      activeSessions.set(deviceId, {
        id: sessionId,
        startTime: now,
        lastSeen: now,
        endTime: null,
        dropouts: [],
        location: currentLocation,
        locationName: locInfo?.name || currentLocation,
        // Track who activated this device
        activator: activator ? {
          deviceId: activator.deviceId,
          deviceName: activator.deviceName,
          rssi: activator.rssi,
          distance: activator.distance
        } : null
      });
      
      // Create aggregated log entry
      const session = activeSessions.get(deviceId);
      const activatorName = session.activator?.deviceName || 'unknown';
      const activatorInfo = session.activator 
        ? ` by ${activatorName}${session.activator.distance ? ` (~${session.activator.distance.toFixed(1)}m)` : ''}`
        : '';
      
      const entry = {
        timestamp: now,
        sessionId,
        deviceId,
        deviceName,
        event: 'session_start',
        status: 'online',
        listType,
        location: currentLocation,
        locationName: locInfo?.name || currentLocation,
        dropouts: 0,
        duration: null,
        summary: `${deviceName} turned on${activatorInfo} at ${formatTime(now)}`,
        // WHO activated this device (closest device in very close proximity)
        activator: session.activator || null
      };
      
      // Add unusual proximity data if present
      if (nearbyUnusual && nearbyUnusual.length > 0) {
        entry.nearbyUnusual = nearbyUnusual;
      }
      
      // Add companion devices (phones etc. near this device — shows who's using it)
      if (nearbyCompanions && nearbyCompanions.length > 0) {
        entry.companions = nearbyCompanions;
      }
      
      // Add movement detection data
      if (movement) {
        entry.movement = {
          moved: movement.moved,
          fromLocation: movement.fromLocation,
          toLocation: movement.toLocation,
          traveledWith: movement.traveledWith,
          leftBehind: movement.leftBehind,
          newCompanions: movement.newCompanions,
          inferredMovement: movement.inferredMovement || false,
          timeSinceLastSeen: movement.timeSinceLastSeen
        };
        
        if (movement.moved) {
          const moveLabel = movement.inferredMovement ? '🔀 companions changed' : `🚚 moved from ${movement.fromLocation}`;
          entry.summary = `${deviceName} came online (${moveLabel})`;
          safeLog(`[MOVEMENT] ${deviceName} ${moveLabel}. Traveled with: ${movement.traveledWith.map(c => c.deviceName).join(', ') || 'none'}`);
        }
      }
      
      log.unshift(entry);
      
    } else if (event === 'offline') {
      const session = activeSessions.get(deviceId);
      
      if (session && !session.endTime) {
        // Mark session as potentially ending (might be a flap)
        session.endTime = now;
        session.lastSeen = now;
        
        // Wait briefly before finalizing - if device comes back, it's a flap
        // For now, update the log entry with current duration
        const duration = now - session.startTime;
        
        // Find and update the session entry
        const sessionEntry = log.find(e => e.sessionId === session.id);
        if (sessionEntry) {
          sessionEntry.duration = duration;
          sessionEntry.endTime = now;
          sessionEntry.status = session.dropouts.length >= FLAP_COUNT_THRESHOLD ? 'unstable' : 'offline';
          sessionEntry.summary = buildSessionSummary(session, deviceName, false);
          sessionEntry.lastUpdate = now;
          store.set('activityLog', log);
          broadcastActivityUpdate(sessionEntry, log);
          
          // If session had dropouts, note it
          if (session.dropouts.length > 0) {
            safeLog(`[ACTIVITY] Session ended for ${deviceName}: ${formatDuration(duration)}, ${session.dropouts.length} dropouts`);
          } else {
            safeLog(`[ACTIVITY] Session ended for ${deviceName}: ${formatDuration(duration)}`);
          }
        }
        
        // Clean up session after a delay (in case device reconnects = flap)
        setTimeout(() => {
          const currentSession = activeSessions.get(deviceId);
          if (currentSession && currentSession.id === session.id && currentSession.endTime) {
            // Session truly ended - finalize
            activeSessions.delete(deviceId);
            safeLog(`[ACTIVITY] Session finalized for ${deviceName}`);
          }
        }, FLAP_THRESHOLD_MS + 1000);
        
        return;
      }
      
      // No active session - create a standalone offline entry
      const entry = {
        timestamp: now,
        deviceId,
        deviceName,
        event: 'offline',
        status: 'offline',
        listType,
        location: currentLocation,
        locationName: locInfo?.name || currentLocation,
        summary: `${deviceName} went offline at ${formatTime(now)}`
      };
      
      log.unshift(entry);
    }
    
    // Keep last 500 aggregated entries (was 1000 raw entries)
    if (log.length > 500) {
      log.length = 500;
    }
    
    store.set('activityLog', log);
    safeLog(`[ACTIVITY] Saved! Log now has ${log.length} entries`);
    
    broadcastActivityUpdate(log[0], log);
    
  } catch (err) {
    safeLog(`[ERROR] logActivity failed: ${err.message}`);
  }
}

function buildSessionSummary(session, deviceName, isOngoing) {
  const now = Date.now();
  const duration = (session.endTime || now) - session.startTime;
  const dropouts = session.dropouts.length;
  
  let summary = `${deviceName}`;
  
  // Add activator info if present
  const activatorName = session.activator?.deviceName;
  const activatorSuffix = activatorName ? ` (by ${activatorName})` : '';
  
  if (isOngoing) {
    summary += ` online ${formatDuration(duration)}${activatorSuffix}`;
    if (dropouts > 0) {
      summary += dropouts >= FLAP_COUNT_THRESHOLD 
        ? ` ⚠️ unstable (${dropouts} dropouts)` 
        : ` (${dropouts} brief dropout${dropouts > 1 ? 's' : ''})`;
    }
    summary += ` • since ${formatTime(session.startTime)}`;
  } else {
    // Session ended
    summary += ` was online ${formatDuration(duration)}${activatorSuffix}`;
    summary += ` (${formatTime(session.startTime)} → ${formatTime(session.endTime)})`;
    if (dropouts > 0) {
      summary += dropouts >= FLAP_COUNT_THRESHOLD 
        ? ` ⚠️ connection unstable` 
        : ` • ${dropouts} brief dropout${dropouts > 1 ? 's' : ''}`;
    }
  }
  
  if (session.locationName) {
    summary += ` @ ${session.locationName}`;
  }
  
  return summary;
}

function broadcastActivityUpdate(entry, log) {
  // Broadcast to API clients
  if (global.broadcastEvent) {
    global.broadcastEvent('activity', entry);
  }
  
  if (mainWindow) {
    mainWindow.webContents.send('activity-log-updated', log);
  }
}

// Send lists update to renderer
function broadcastLists() {
  if (mainWindow) {
    mainWindow.webContents.send('lists-updated', store.get('lists'));
  }
}

// IPC Handlers
ipcMain.handle('get-lists', () => store.get('lists'));
ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('get-activity-log', () => store.get('activityLog'));
ipcMain.handle('get-discovered-devices', () => {
  return getAggregatedDevices();
});

/**
 * Aggregate devices to prevent UI overload.
 * - Individual listed devices (whitelist/greylist) always shown
 * - Unique named devices shown individually
 * - "Apple Device" entries collapsed into summary groups by signal strength band
 * - "Unknown Device" entries collapsed into a single summary
 * - Companion detection: which devices are near whitelisted ones
 */
function getAggregatedDevices() {
  const lists = store.get('lists');
  const devices = Array.from(discoveredDevices.values());
  const result = [];
  
  // Categorise devices
  const listedDevices = [];      // On whitelist/greylist — always show
  const uniqueNamed = [];        // Real names (not "Apple Device" / "Unknown Device")
  const appleDevices = [];       // Generic "Apple Device"
  const unknownDevices = [];     // "Unknown Device"
  const otherGeneric = [];       // "Microsoft Device", "Samsung Device", etc.
  
  for (const d of devices) {
    if (lists.blacklist[d.id]) continue; // Skip blacklisted
    
    const isListed = !!(lists.whitelist[d.id] || lists.greylist[d.id]);
    
    if (isListed) {
      listedDevices.push(d);
    } else if (d.name === 'Apple Device') {
      appleDevices.push(d);
    } else if (d.name === 'Unknown Device' || d.isUnknown) {
      unknownDevices.push(d);
    } else if (['Microsoft Device', 'Samsung Device', 'Google Device'].includes(d.name)) {
      otherGeneric.push(d);
    } else {
      uniqueNamed.push(d);
    }
  }
  
  // 1. Listed devices first (always individual)
  for (const d of listedDevices) {
    d._priority = 0;
    result.push(d);
  }
  
  // 2. Unique named devices
  for (const d of uniqueNamed) {
    d._priority = 1;
    result.push(d);
  }
  
  // 3. Apple devices — aggregate into signal bands with companion info
  if (appleDevices.length > 0) {
    const nearbyWhitelist = getCompanionSnapshot();
    
    // Split into "close" (>-70 dBm), "medium" (-70 to -85), "far" (<-85)
    const close = appleDevices.filter(d => d.rssi > -70);
    const medium = appleDevices.filter(d => d.rssi <= -70 && d.rssi > -85);
    const far = appleDevices.filter(d => d.rssi <= -85);
    
    if (close.length > 0) {
      result.push(createGroupSummary('Apple Devices (Close)', close, 'apple-close', nearbyWhitelist));
    }
    if (medium.length > 0) {
      result.push(createGroupSummary('Apple Devices (Nearby)', medium, 'apple-medium', nearbyWhitelist));
    }
    if (far.length > 0) {
      result.push(createGroupSummary('Apple Devices (Far)', far, 'apple-far', nearbyWhitelist));
    }
  }
  
  // 4. Other generic manufacturers — one summary each
  const otherByName = {};
  for (const d of otherGeneric) {
    if (!otherByName[d.name]) otherByName[d.name] = [];
    otherByName[d.name].push(d);
  }
  for (const [name, devs] of Object.entries(otherByName)) {
    if (devs.length === 1) {
      devs[0]._priority = 3;
      result.push(devs[0]);
    } else {
      result.push(createGroupSummary(name, devs, name.toLowerCase().replace(/\s+/g, '-')));
    }
  }
  
  // 5. Unknown devices — single summary
  if (unknownDevices.length > 0) {
    result.push(createGroupSummary('Unknown Devices', unknownDevices, 'unknown'));
  }
  
  return result;
}

function createGroupSummary(name, devices, groupId, companionMap) {
  const strongestRssi = Math.max(...devices.map(d => d.rssi));
  const weakestRssi = Math.min(...devices.map(d => d.rssi));
  const avgRssi = Math.round(devices.reduce((s, d) => s + d.rssi, 0) / devices.length);
  const newest = Math.max(...devices.map(d => d.lastSeen || 0));
  const oldest = Math.min(...devices.map(d => d.firstSeen || Date.now()));
  
  // Count how many have random MACs (locally administered)
  let randomMacCount = 0;
  for (const d of devices) {
    try {
      const firstByte = parseInt(d.id.split(':')[0] || d.id.substring(0, 2), 16);
      if (firstByte & 0x02) randomMacCount++;
    } catch {}
  }
  
  return {
    id: `__group_${groupId}`,
    name: name,
    isGroup: true,
    groupId: groupId,
    deviceCount: devices.length,
    randomMacCount: randomMacCount,
    rssi: strongestRssi,
    rssiRange: { min: weakestRssi, max: strongestRssi, avg: avgRssi },
    firstSeen: oldest,
    lastSeen: newest,
    isUnknown: groupId === 'unknown',
    nameSource: 'group',
    companions: companionMap || null,
    // Include the 5 strongest individual devices for expand view
    topDevices: devices
      .sort((a, b) => b.rssi - a.rssi)
      .slice(0, 5)
      .map(d => ({ id: d.id, rssi: d.rssi, lastSeen: d.lastSeen })),
    _priority: groupId === 'unknown' ? 5 : 2
  };
}

/**
 * Build companion snapshot: for each whitelisted device that's online,
 * find what other devices are nearby (strong signal).
 * Enriched with historical companion data and proximity info.
 */
function getCompanionSnapshot() {
  const lists = store.get('lists');
  const companions = {};
  
  // Load persisted companion history
  const savedHistory = store.get('companionHistory') || {};
  // Merge in-memory with persisted (in-memory takes priority)
  const history = { ...savedHistory, ...companionHistory };
  
  for (const [devId, info] of Object.entries(lists.whitelist || {})) {
    if (!info.online) continue;
    
    const nearby = [];
    const devHistory = history[devId] || {};
    
    for (const [otherId, otherDev] of discoveredDevices) {
      if (otherId === devId) continue;
      if (otherDev.rssi > -75) { // Strong signal = truly nearby
        const hist = devHistory[otherId];
        nearby.push({
          id: otherId,
          name: otherDev.name,
          rssi: otherDev.rssi,
          seenTogetherCount: hist?.count || 0,
          isRegular: (hist?.count || 0) > 5,  // Seen together >5 times = regular companion
          isNew: !hist  // Never seen before with this device
        });
      }
    }
    
    // Sort: new/unusual first, then by signal strength
    nearby.sort((a, b) => {
      if (a.isNew && !b.isNew) return -1;
      if (!a.isNew && b.isNew) return 1;
      return b.rssi - a.rssi;
    });
    
    // Proximity info for the whitelisted device itself
    const proximity = getProximityInfo(devId);
    
    companions[devId] = {
      deviceName: info.name,
      nearbyCount: nearby.length,
      nearbyStrong: nearby.filter(n => n.rssi > -60).length,
      proximity: proximity,
      topCompanions: nearby.slice(0, 5),  // Top 5 nearby devices
      regularCompanions: nearby.filter(n => n.isRegular).map(n => n.name),
      newCompanions: nearby.filter(n => n.isNew).map(n => ({ name: n.name, rssi: n.rssi }))
    };
  }
  
  return companions;
}

/**
 * Phase 2: Record which devices are near a whitelisted/greylisted device.
 * Builds a persistent companion fingerprint over time.
 */
function recordCompanionSnapshot(trackedDeviceId) {
  if (!companionHistory[trackedDeviceId]) {
    companionHistory[trackedDeviceId] = {};
  }
  
  const history = companionHistory[trackedDeviceId];
  const now = Date.now();
  
  for (const [otherId, otherDev] of discoveredDevices) {
    if (otherId === trackedDeviceId) continue;
    if (otherDev.rssi > -75) {  // Only count strong signals as "nearby"
      if (!history[otherId]) {
        history[otherId] = { count: 0, firstSeen: now, lastSeen: now, avgRssi: otherDev.rssi, name: otherDev.name };
      }
      history[otherId].count++;
      history[otherId].lastSeen = now;
      history[otherId].name = otherDev.name;
      // Rolling average RSSI
      history[otherId].avgRssi = Math.round(
        (history[otherId].avgRssi * 0.8) + (otherDev.rssi * 0.2)
      );
    }
  }
  
  // Persist every 60 seconds to prevent store thrashing
  if (!recordCompanionSnapshot._lastPersist || now - recordCompanionSnapshot._lastPersist > 60000) {
    store.set('companionHistory', companionHistory);
    recordCompanionSnapshot._lastPersist = now;
  }
}

/**
 * Phase 3: Get proximity / movement info for a device based on RSSI history.
 * Returns: { distance, trend, description }
 */
function getProximityInfo(deviceId) {
  const history = rssiHistory[deviceId];
  if (!history || history.length < 2) {
    return null;
  }
  
  const latest = history[history.length - 1].rssi;
  
  // Rough distance estimate from RSSI (very approximate)
  // RSSI = txPower - 10 * n * log10(distance) ; n ≈ 2 for BLE
  // Simplified: distance ≈ 10^((txPower - RSSI) / (10 * n))
  // Assuming txPower ≈ -59 (typical BLE at 1m)
  const txPower = -59;
  const n = 2;
  const distanceM = Math.pow(10, (txPower - latest) / (10 * n));
  
  let distanceLabel;
  if (distanceM < 1) distanceLabel = 'Very close (<1m)';
  else if (distanceM < 3) distanceLabel = 'Close (1-3m)';
  else if (distanceM < 8) distanceLabel = 'Nearby (3-8m)';
  else if (distanceM < 15) distanceLabel = 'Same room (~10m)';
  else distanceLabel = 'Far (>15m)';
  
  // Trend detection: compare last 5 readings average vs previous 5
  let trend = 'stationary';
  if (history.length >= 10) {
    const recent5 = history.slice(-5).reduce((s, h) => s + h.rssi, 0) / 5;
    const prev5 = history.slice(-10, -5).reduce((s, h) => s + h.rssi, 0) / 5;
    const delta = recent5 - prev5;
    
    if (delta > 5) trend = 'approaching';        // Signal getting stronger
    else if (delta < -5) trend = 'moving-away';    // Signal getting weaker
  }
  
  const trendIcons = {
    'approaching': '🟢 Approaching',
    'stationary': '🔵 Stationary',
    'moving-away': '🔴 Moving away'
  };
  
  return {
    rssi: latest,
    distanceM: Math.round(distanceM * 10) / 10,
    distanceLabel,
    trend,
    trendLabel: trendIcons[trend] || trend,
    readings: history.length
  };
}

ipcMain.handle('add-to-list', (event, { deviceId, deviceName, listType }) => {
  const lists = store.get('lists');
  
  // Remove from other lists first
  delete lists.blacklist[deviceId];
  delete lists.greylist[deviceId];
  delete lists.whitelist[deviceId];
  
  // Add to specified list
  lists[listType][deviceId] = {
    name: deviceName,
    addedAt: Date.now(),
    lastSeen: null,
    online: false
  };
  
  store.set('lists', lists);
  broadcastLists();
  return lists;
});

ipcMain.handle('remove-from-list', (event, { deviceId, listType }) => {
  const lists = store.get('lists');
  if (lists[listType]) {
    delete lists[listType][deviceId];
    store.set('lists', lists);
  }
  deviceStates.delete(deviceId);
  broadcastLists();
  return lists;
});

ipcMain.handle('move-to-list', (event, { deviceId, fromList, toList }) => {
  const lists = store.get('lists');
  
  // Get device info from old list
  const deviceInfo = lists[fromList]?.[deviceId];
  if (deviceInfo) {
    delete lists[fromList][deviceId];
    lists[toList][deviceId] = deviceInfo;
    store.set('lists', lists);
  }
  
  broadcastLists();
  return lists;
});

ipcMain.handle('bulk-add-to-list', (event, { devices, listType }) => {
  const lists = store.get('lists');
  
  for (const { id, name } of devices) {
    // Remove from all lists first
    delete lists.blacklist[id];
    delete lists.greylist[id];
    delete lists.whitelist[id];
    
    // Add to specified list
    lists[listType][id] = {
      name: name,
      addedAt: Date.now(),
      lastSeen: null,
      online: false
    };
  }
  
  store.set('lists', lists);
  broadcastLists();
  return lists;
});

ipcMain.handle('update-device-name', (event, { deviceId, name }) => {
  const lists = store.get('lists');
  
  // Update name in whichever list the device is in
  for (const listType of ['blacklist', 'greylist', 'whitelist']) {
    if (lists[listType][deviceId]) {
      lists[listType][deviceId].name = name;
      break;
    }
  }
  
  store.set('lists', lists);
  broadcastLists();
  return lists;
});

ipcMain.handle('update-settings', (event, newSettings) => {
  const settings = store.get('settings');
  Object.assign(settings, newSettings);
  store.set('settings', settings);
  return settings;
});

ipcMain.handle('clear-activity-log', () => {
  store.set('activityLog', []);
  return [];
});

ipcMain.handle('start-scanning', () => {
  startScanning();
  return true;
});

ipcMain.handle('stop-scanning', () => {
  stopScanning();
  return false;
});

ipcMain.handle('get-bluetooth-state', () => {
  return noble ? noble.state : 'unknown';
});

ipcMain.handle('get-scanning-state', () => {
  return isScanning;
});

// Track scanning state
let isScanning = false;

// Location IPC Handlers (GPS/radius-based)
ipcMain.handle('get-locations', () => store.get('locations') || []);

ipcMain.handle('get-current-location', () => {
  const locations = store.get('locations') || [];
  const loc = currentLocation ? locations.find(l => l.id === currentLocation) : null;
  return {
    id: currentLocation,
    name: loc?.name || null,
    coords: currentCoords,
    isUnknown: currentLocation === null
  };
});

ipcMain.handle('get-current-coords', () => currentCoords);

ipcMain.handle('set-location', (event, locationId) => {
  currentLocation = locationId;
  store.set('currentLocation', locationId);
  updateTrayMenu();
  const locations = store.get('locations') || [];
  const loc = locations.find(l => l.id === locationId);
  return { id: locationId, name: loc?.name || locationId };
});

// Add a new location at current coordinates (or custom coords)
ipcMain.handle('add-location', (event, { name, lat, lon, radiusKm }) => {
  const locations = store.get('locations') || [];
  const id = `loc-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  
  // Use provided coords or current coords
  const useLat = lat ?? currentCoords?.lat;
  const useLon = lon ?? currentCoords?.lon;
  
  if (useLat && useLon) {
    const newLoc = { 
      id, 
      name, 
      lat: useLat, 
      lon: useLon, 
      radiusKm: radiusKm || 5  // Default 5km radius
    };
    locations.push(newLoc);
    store.set('locations', locations);
    updateTrayMenu();
    
    // Auto-set as current location since we just created it here
    currentLocation = id;
    store.set('currentLocation', id);
    
    safeLog(`Added location: ${name} at (${useLat}, ${useLon}) with ${radiusKm || 5}km radius`);
    return { locations, newLocation: newLoc };
  }
  
  return { locations, error: 'No coordinates available' };
});

ipcMain.handle('update-location', (event, { id, name, lat, lon, radiusKm }) => {
  const locations = store.get('locations') || [];
  const loc = locations.find(l => l.id === id);
  if (loc) {
    if (name !== undefined) loc.name = name;
    if (lat !== undefined) loc.lat = lat;
    if (lon !== undefined) loc.lon = lon;
    if (radiusKm !== undefined) loc.radiusKm = radiusKm;
    store.set('locations', locations);
    updateTrayMenu();
    safeLog(`Updated location: ${loc.name}`);
  }
  return locations;
});

ipcMain.handle('remove-location', (event, locationId) => {
  let locations = store.get('locations') || [];
  locations = locations.filter(l => l.id !== locationId);
  store.set('locations', locations);
  
  // If we deleted the current location, set to null
  if (currentLocation === locationId) {
    currentLocation = null;
    store.set('currentLocation', null);
  }
  
  updateTrayMenu();
  return locations;
});

// Force re-detect location (e.g., after adding a new one)
ipcMain.handle('refresh-location', async () => {
  await detectLocation();
  updateTrayMenu();
  const locations = store.get('locations') || [];
  const loc = currentLocation ? locations.find(l => l.id === currentLocation) : null;
  return {
    id: currentLocation,
    name: loc?.name || null,
    coords: currentCoords,
    isUnknown: currentLocation === null
  };
});

// App lifecycle
let locationCheckInterval = null;

// ============================================================
// SINGLE INSTANCE LOCK - Prevent zombie apps
// ============================================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running - quit this one
  console.log('[App] Another instance is already running, quitting...');
  app.quit();
} else {
  // This is the primary instance
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance (e.g. Mission Control auto-start)
    // Do NOT steal focus — just log it. User can click tray icon if they want it.
    safeLog('Second instance attempted — ignored (not stealing focus)');
  });

  app.whenReady().then(async () => {
  // Detect location on startup
  await detectLocation();
  
  createWindow();
  createTray();
  await initBluetooth();
  
  // Initialize API server for Mission Control web interface
  const apiApp = initApiServer({
    store,
    discoveredDevices,
    deviceStates,
    isScanning,
    noble,
    currentLocation,
    currentCoords,
    startScanning,
    stopScanning,
    logDir: LOG_DIR,  // Pass log directory for /api/logs endpoint
    getAggregatedDevices  // Phase 1: aggregated device view for API
  });
  
  // Store broadcast function for real-time updates
  global.broadcastEvent = apiApp.broadcastEvent;
  
  // Check location periodically (every 5 minutes)
  locationCheckInterval = setInterval(async () => {
    await detectLocation();
    updateTrayMenu();
  }, 5 * 60 * 1000);
  
  // Start co-location decay timer (daily)
  startCoLocationDecay();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    stopScanning();
    if (coLocationDecayTimer) clearInterval(coLocationDecayTimer);
  });
} // End of single instance lock else block
