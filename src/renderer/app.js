// State
let discoveredDevices = [];
let lists = { blacklist: {}, greylist: {}, whitelist: {} };
let activityLog = [];
let locations = [];
let currentLocation = null;
let currentWifi = null;
let isScanning = false;
let bulkMode = false;
let selectedDevices = new Set();

// DOM Elements
const bluetoothStatus = document.getElementById('bluetooth-status');
const scanToggle = document.getElementById('scan-toggle');
const deviceList = document.getElementById('device-list');
const deviceCount = document.getElementById('device-count');
const whitelistList = document.getElementById('whitelist-list');
const whitelistCount = document.getElementById('whitelist-count');
const greylistList = document.getElementById('greylist-list');
const greylistCount = document.getElementById('greylist-count');
const blacklistList = document.getElementById('blacklist-list');
const blacklistCount = document.getElementById('blacklist-count');
const activityLogEl = document.getElementById('activity-log');
const clearLogBtn = document.getElementById('clear-log');
const bulkActions = document.getElementById('bulk-actions');
const selectedCountEl = document.getElementById('selected-count');
const toggleBulkBtn = document.getElementById('toggle-bulk');

// Settings elements
const scanIntervalInput = document.getElementById('scan-interval');
const offlineThresholdInput = document.getElementById('offline-threshold');
const notificationsEnabledInput = document.getElementById('notifications-enabled');
const startMinimizedInput = document.getElementById('start-minimized');
const minimizeToTrayInput = document.getElementById('minimize-to-tray');
const saveSettingsBtn = document.getElementById('save-settings');

// Location elements
const currentLocationName = document.getElementById('current-location-name');
const currentWifiEl = document.getElementById('current-wifi');
const locationListEl = document.getElementById('location-list');
const newLocationNameInput = document.getElementById('new-location-name');
const addLocationBtn = document.getElementById('add-location-btn');

// Relative time formatter
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 0) return 'just now';
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  const days = Math.round(diff / 86400000);
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

// Tab switching with hash anchors + hotkeys
const TAB_NAMES = ['devices', 'whitelist', 'greylist', 'blacklist', 'log', 'settings'];
const TAB_HOTKEYS = { '1': 'devices', '2': 'whitelist', '3': 'greylist', '4': 'blacklist', '5': 'log', '6': 'settings' };

function switchTab(tabName) {
  if (!TAB_NAMES.includes(tabName)) return;
  
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  
  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const tabContent = document.getElementById(`${tabName}-tab`);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
  
  // Update hash without triggering hashchange
  history.replaceState(null, '', `#${tabName}`);
  
  // Refresh data on tab switch
  if (tabName === 'devices' && renderPending) {
    renderPending = false;
    deviceRenderLimit = DEVICE_RENDER_LIMIT;
    doRenderDevices();
  } else if (tabName === 'log') {
    renderActivityLog();
  }
}

// Click handlers
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Hash anchor navigation
function handleHash() {
  const hash = window.location.hash.replace('#', '');
  if (hash && TAB_NAMES.includes(hash)) {
    switchTab(hash);
  }
}
window.addEventListener('hashchange', handleHash);

// Keyboard hotkeys: 1-6 to switch tabs (only when not typing in input)
document.addEventListener('keydown', (e) => {
  // Don't intercept if typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  
  const tabName = TAB_HOTKEYS[e.key];
  if (tabName) {
    e.preventDefault();
    switchTab(tabName);
  }
  
  // 'r' to refresh current tab
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const activeTab = document.querySelector('.tab.active');
    const refreshBtn = document.querySelector(`.tab-refresh[data-refresh="${activeTab?.dataset.tab}"]`);
    if (refreshBtn) refreshBtn.click();
  }
});

// Initialize
async function init() {
  // Load initial data
  lists = await window.api.getLists();
  activityLog = await window.api.getActivityLog();
  const settings = await window.api.getSettings();
  discoveredDevices = await window.api.getDiscoveredDevices();
  locations = await window.api.getLocations();
  const locInfo = await window.api.getCurrentLocation();
  currentLocation = locInfo;
  currentWifi = locInfo.wifi;
  
  // Get current bluetooth and scanning state (fixes "stuck on initializing")
  const btState = await window.api.getBluetoothState();
  bluetoothStatus.textContent = btState;
  bluetoothStatus.className = `status ${btState === 'poweredOn' ? 'powered-on' : 'powered-off'}`;
  
  isScanning = await window.api.getScanningState();
  scanToggle.textContent = isScanning ? 'Stop Scan' : 'Start Scan';
  scanToggle.classList.toggle('btn-secondary', isScanning);
  scanToggle.classList.toggle('btn-primary', !isScanning);
  
  // Apply settings to UI
  scanIntervalInput.value = settings.scanInterval / 1000;
  offlineThresholdInput.value = settings.offlineThreshold / 1000;
  notificationsEnabledInput.checked = settings.notificationsEnabled;
  startMinimizedInput.checked = settings.startMinimized || false;
  minimizeToTrayInput.checked = settings.minimizeToTray !== false;
  
  renderDevices();
  renderList('whitelist');
  renderList('greylist');
  renderList('blacklist');
  renderActivityLog();
  renderLocations();
  updateTabBadges();
  
  // Set up event listeners
  setupEventListeners();
  
  // Handle initial hash anchor (e.g. #log, #whitelist)
  handleHash();
}

function setupEventListeners() {
  // Scan toggle
  scanToggle.addEventListener('click', async () => {
    if (isScanning) {
      await window.api.stopScanning();
    } else {
      await window.api.startScanning();
    }
  });
  
  // Clear log
  clearLogBtn.addEventListener('click', async () => {
    activityLog = await window.api.clearActivityLog();
    renderActivityLog();
  });
  
  // Unhide All - clear the entire blacklist
  document.getElementById('unhide-all').addEventListener('click', async () => {
    const count = Object.keys(lists.blacklist || {}).length;
    if (count === 0) {
      alert('No hidden devices to unhide.');
      return;
    }
    if (!confirm(`Unhide all ${count} hidden devices? They will reappear in Nearby.`)) return;
    
    // Remove each device from blacklist
    for (const deviceId of Object.keys(lists.blacklist)) {
      await window.api.removeFromList(deviceId, 'blacklist');
    }
    
    lists = await window.api.getLists();
    updateTabBadges();
    renderList('blacklist');
    doRenderDevices();
  });
  
  // Bulk mode toggle
  toggleBulkBtn.addEventListener('click', () => {
    bulkMode = !bulkMode;
    selectedDevices.clear();
    bulkActions.classList.toggle('hidden', !bulkMode);
    toggleBulkBtn.textContent = bulkMode ? '❌ Exit Bulk' : '☑️ Bulk Select';
    toggleBulkBtn.classList.toggle('btn-primary', bulkMode);
    toggleBulkBtn.classList.toggle('btn-secondary', !bulkMode);
    renderDevices();
  });
  
  // Select All
  document.getElementById('select-all').addEventListener('click', () => {
    const visibleDevices = discoveredDevices.filter(d => !lists.blacklist[d.id]);
    const allSelected = visibleDevices.length > 0 && visibleDevices.every(d => selectedDevices.has(d.id));
    
    if (allSelected) {
      // Deselect all
      selectedDevices.clear();
      document.getElementById('select-all').textContent = '☑️ Select All';
    } else {
      // Select all
      visibleDevices.forEach(d => selectedDevices.add(d.id));
      document.getElementById('select-all').textContent = '☐ Deselect All';
    }
    renderDevices();
  });
  
  // Bulk actions
  document.getElementById('bulk-whitelist').addEventListener('click', () => bulkAddToList('whitelist'));
  document.getElementById('bulk-greylist').addEventListener('click', () => bulkAddToList('greylist'));
  document.getElementById('bulk-blacklist').addEventListener('click', () => bulkAddToList('blacklist'));
  document.getElementById('bulk-cancel').addEventListener('click', () => {
    bulkMode = false;
    selectedDevices.clear();
    bulkActions.classList.add('hidden');
    toggleBulkBtn.textContent = '☑️ Bulk Select';
    toggleBulkBtn.classList.remove('btn-primary');
    toggleBulkBtn.classList.add('btn-secondary');
    renderDevices();
  });
  
  // Save settings
  saveSettingsBtn.addEventListener('click', async () => {
    const settings = {
      scanInterval: parseInt(scanIntervalInput.value) * 1000,
      offlineThreshold: parseInt(offlineThresholdInput.value) * 1000,
      notificationsEnabled: notificationsEnabledInput.checked,
      startMinimized: startMinimizedInput.checked,
      minimizeToTray: minimizeToTrayInput.checked
    };
    await window.api.updateSettings(settings);
    saveSettingsBtn.textContent = 'Saved!';
    setTimeout(() => { saveSettingsBtn.textContent = 'Save Settings'; }, 2000);
  });
  
  // Add location (at current GPS coordinates)
  addLocationBtn.addEventListener('click', async () => {
    const name = newLocationNameInput.value.trim();
    if (!name) return;
    
    // Get radius if element exists
    const radiusInput = document.getElementById('new-location-radius');
    const radiusKm = radiusInput ? parseFloat(radiusInput.value) || 5 : 5;
    
    const result = await window.api.addLocation({ name, radiusKm });
    if (result.error) {
      alert(`Could not add location: ${result.error}`);
      return;
    }
    
    locations = result.locations;
    newLocationNameInput.value = '';
    if (radiusInput) radiusInput.value = '5';
    
    // Update current location since we auto-set it
    currentLocation = await window.api.getCurrentLocation();
    renderLocations();
  });
  
  newLocationNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLocationBtn.click();
  });
  
  // Location changed event from main
  window.api.onLocationChanged((loc) => {
    currentLocation = { id: loc.id, name: loc.name, coords: currentLocation?.coords };
    renderLocations();
  });
  
  // Unknown location event - prompt to save
  window.api.onUnknownLocation && window.api.onUnknownLocation((data) => {
    currentLocation = { id: null, name: null, coords: data.coords, isUnknown: true };
    renderLocations();
  });
  
  // Show add location dialog (from tray menu)
  window.api.onShowAddLocation && window.api.onShowAddLocation(() => {
    // Switch to locations tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="locations"]')?.classList.add('active');
    document.getElementById('locations-tab')?.classList.add('active');
    newLocationNameInput.focus();
  });
  
  // Tab refresh buttons
  document.querySelectorAll('.tab-refresh').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = btn.dataset.refresh;
      btn.textContent = '⏳';
      btn.disabled = true;
      
      try {
        if (target === 'devices') {
          discoveredDevices = await window.api.getDiscoveredDevices();
          doRenderDevices();
        } else if (target === 'whitelist' || target === 'greylist' || target === 'blacklist') {
          lists = await window.api.getLists();
          renderList(target);
        } else if (target === 'log') {
          activityLog = await window.api.getActivityLog();
          renderActivityLog();
        }
      } catch (err) {
        console.error('Refresh failed:', err);
      }
      
      setTimeout(() => {
        btn.textContent = '🔄';
        btn.disabled = false;
      }, 500);
    });
  });
  
  // IPC events from main process
  window.api.onBluetoothState((state) => {
    bluetoothStatus.textContent = state;
    bluetoothStatus.className = `status ${state === 'poweredOn' ? 'powered-on' : 'powered-off'}`;
  });
  
  window.api.onScanningState((scanning) => {
    isScanning = scanning;
    scanToggle.textContent = scanning ? 'Stop Scan' : 'Start Scan';
    scanToggle.classList.toggle('btn-secondary', scanning);
    scanToggle.classList.toggle('btn-primary', !scanning);
  });
  
  window.api.onDeviceDiscovered((device) => {
    // For individual (listed/named) devices, update in place
    if (!device.isGroup) {
      const idx = discoveredDevices.findIndex(d => d.id === device.id);
      if (idx >= 0) {
        discoveredDevices[idx] = device;
      } else {
        // Only add if it's a genuinely unique/listed device, not generic
        if (device.name !== 'Apple Device' && device.name !== 'Unknown Device') {
          discoveredDevices.push(device);
        }
      }
    }
    // Don't re-render for every single device — batch update handles that
  });
  
  // Handle batched device updates — now receives aggregated data from main
  window.api.onDeviceBatchUpdate && window.api.onDeviceBatchUpdate((updates) => {
    // Filter out any blacklisted devices from incoming updates
    const filtered = updates.filter(d => !lists.blacklist[d.id]);
    
    // If updates contain group summaries, replace the full device list
    const hasGroups = filtered.some(u => u.isGroup);
    if (hasGroups) {
      // Full aggregated update — replace everything (but keep blacklist filter)
      discoveredDevices = filtered;
    } else {
      // Individual updates (legacy path) — skip blacklisted
      for (const device of filtered) {
        if (lists.blacklist[device.id]) continue;
        const idx = discoveredDevices.findIndex(d => d.id === device.id);
        if (idx >= 0) {
          discoveredDevices[idx] = device;
        } else {
          discoveredDevices.push(device);
        }
      }
    }
    renderDevices();
  });
  
  window.api.onDeviceStatusChange(({ deviceId, status, listType }) => {
    // Update list UI
    if (lists[listType]?.[deviceId]) {
      lists[listType][deviceId].online = status === 'online';
      renderList(listType);
    }
  });
  
  window.api.onActivityLogUpdated((log) => {
    activityLog = log;
    renderActivityLog();
  });
  
  window.api.onListsUpdated((newLists) => {
    console.log('[EVENT] lists-updated received:', newLists);
    console.log('[EVENT] Blacklist in event:', Object.keys(newLists.blacklist || {}));
    lists = newLists;
    renderList('whitelist');
    renderList('greylist');
    renderList('blacklist');
    renderDevices();
    updateTabBadges();
  });
}

function getDeviceListType(deviceId) {
  if (lists.blacklist[deviceId]) return 'blacklist';
  if (lists.greylist[deviceId]) return 'greylist';
  if (lists.whitelist[deviceId]) return 'whitelist';
  return null;
}

// Update tab badge counts
function updateTabBadges() {
  const whitelistBadge = document.getElementById('tab-whitelist-count');
  const greylistBadge = document.getElementById('tab-greylist-count');
  const blacklistBadge = document.getElementById('tab-blacklist-count');
  
  const wCount = Object.keys(lists.whitelist || {}).length;
  const gCount = Object.keys(lists.greylist || {}).length;
  const bCount = Object.keys(lists.blacklist || {}).length;
  
  if (whitelistBadge) whitelistBadge.textContent = wCount > 0 ? wCount : '';
  if (greylistBadge) greylistBadge.textContent = gCount > 0 ? gCount : '';
  if (blacklistBadge) blacklistBadge.textContent = bCount > 0 ? bCount : '';
}

// Track collapsed state for unknown devices and grouped devices
let unknownCollapsed = true;
let expandedGroups = new Set();  // Groups start COLLAPSED, track which are EXPANDED
let renderPending = false;
let lastRenderTime = 0;
let rafId = null;

// Fast reactive render using requestAnimationFrame
function scheduleRender() {
  // Skip if already scheduled
  if (rafId) return;
  
  // Skip rendering if devices tab isn't visible
  const devicesTab = document.getElementById('devices-tab');
  if (devicesTab && !devicesTab.classList.contains('active')) {
    renderPending = true;
    return;
  }
  
  rafId = requestAnimationFrame(() => {
    rafId = null;
    renderPending = false;
    doRenderDevices();
  });
}

function renderDevices() {
  scheduleRender();
}

const DEVICE_RENDER_LIMIT = 100; // Max devices to render at once to prevent UI lockup
let deviceRenderLimit = DEVICE_RENDER_LIMIT;

function doRenderDevices() {
  lastRenderTime = Date.now();
  
  // Debug: show what's in blacklist
  const blacklistIds = Object.keys(lists.blacklist || {});
  console.log(`Rendering. Blacklist has ${blacklistIds.length} IDs:`, blacklistIds);
  
  // Filter out blacklisted devices
  const devices = discoveredDevices.filter(d => {
    const isBlacklisted = !!lists.blacklist[d.id];
    if (isBlacklisted) {
      console.log(`FILTERED OUT blacklisted device: ${d.id}`);
    }
    return !isBlacklisted;
  });
  
  console.log(`After filter: ${devices.length} of ${discoveredDevices.length} devices shown`);
  
  const groups = devices.filter(d => d.isGroup);
  const individuals = devices.filter(d => !d.isGroup);
  
  const totalDeviceCount = individuals.length + groups.reduce((s, g) => s + (g.deviceCount || 0), 0);
  deviceCount.textContent = `${individuals.length} named, ${groups.length} groups (${totalDeviceCount} total)`;
  
  if (devices.length === 0) {
    deviceList.innerHTML = '<p class="empty-state">No devices discovered yet. Start scanning to find nearby Bluetooth devices.</p>';
    return;
  }
  
  function renderDeviceItem(device) {
    const listType = getDeviceListType(device.id);
    const isSelected = selectedDevices.has(device.id);
    const listClass = listType ? `in-${listType}` : '';
    const escapedName = escapeHtml(device.name);
    
    const firstSeenStr = device.firstSeen ? formatRelativeTime(device.firstSeen) : null;
    const lastSeenStr = device.lastSeen ? formatRelativeTime(device.lastSeen) : null;
    const timestampsHtml = (firstSeenStr || lastSeenStr) ? `
      <div class="device-timestamps">
        ${firstSeenStr ? `First: ${firstSeenStr}` : ''}${firstSeenStr && lastSeenStr ? ' · ' : ''}${lastSeenStr ? `Last: ${lastSeenStr}` : ''}
      </div>
    ` : '';
    
    return `
      <div class="device-item ${listClass} ${isSelected ? 'selected' : ''}" data-id="${device.id}">
        ${bulkMode ? `
          <label class="checkbox-wrapper" data-device-id="${device.id}">
            <input type="checkbox" ${isSelected ? 'checked' : ''}>
          </label>
        ` : ''}
        <div class="device-info" ${bulkMode ? `data-device-id="${device.id}"` : ''}>
          <div class="device-name">${escapedName}</div>
          <div class="device-meta">
            ${device.id.slice(0, 8)}... | ${device.rssi} dBm
            ${device.nameSource && device.nameSource !== 'none' && device.nameSource !== 'group' ? `<span class="source-badge">${device.nameSource}</span>` : ''}
            ${listType ? `<span class="list-badge ${listType}">${listType}</span>` : ''}
          </div>
          ${timestampsHtml}
        </div>
        ${!bulkMode ? `
          <div class="quick-actions">
            <button class="quick-btn ${listType === 'whitelist' ? 'active' : ''}" 
              data-device-id="${device.id}" data-device-name="${escapedName}" data-list="whitelist"
              title="Whitelist (notifications)">🔔</button>
            <button class="quick-btn ${listType === 'greylist' ? 'active' : ''}" 
              data-device-id="${device.id}" data-device-name="${escapedName}" data-list="greylist"
              title="Greylist (log only)">📝</button>
            <button class="quick-btn ${listType === 'blacklist' ? 'active' : ''}" 
              data-device-id="${device.id}" data-device-name="${escapedName}" data-list="blacklist"
              title="Blacklist (hide)">🚫</button>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  function renderGroupSummary(group) {
    const groupKey = group.groupId;
    const isExpanded = expandedGroups.has(groupKey);
    const range = group.rssiRange || {};
    const isApple = groupKey.startsWith('apple');
    const icon = isApple ? '🍎' : (group.isUnknown ? '❓' : '📱');
    
    // Signal strength indicator
    let signalClass = 'signal-far';
    if (range.max > -60) signalClass = 'signal-close';
    else if (range.max > -75) signalClass = 'signal-medium';
    
    // Companion info for Apple groups — enriched with proximity + unusual alerts
    let companionHtml = '';
    if (group.companions) {
      const online = Object.values(group.companions).filter(c => c.nearbyCount > 0);
      if (online.length > 0) {
        const parts = online.map(c => {
          const proxLabel = c.proximity ? ` · ${c.proximity.trendLabel}` : '';
          const distLabel = c.proximity ? ` ~${c.proximity.distanceLabel}` : '';
          let html = `<span class="companion-tag">👤 ${escapeHtml(c.deviceName)} (${c.nearbyStrong} close${distLabel}${proxLabel})</span>`;
          
          // Alert for new unknown companions
          if (c.newCompanions && c.newCompanions.length > 0) {
            const newNames = c.newCompanions.slice(0, 3).map(n => `${escapeHtml(n.name)} (${n.rssi}dBm)`).join(', ');
            html += `<span class="companion-alert">⚠️ New: ${newNames}</span>`;
          }
          
          // Show regular companions
          if (c.regularCompanions && c.regularCompanions.length > 0) {
            html += `<span class="companion-regular">✅ Usual: ${c.regularCompanions.slice(0, 3).join(', ')}</span>`;
          }
          
          return html;
        });
        companionHtml = `<div class="group-companions">Near: ${parts.join(' ')}</div>`;
      }
    }
    
    const randomPct = group.randomMacCount ? Math.round(group.randomMacCount / group.deviceCount * 100) : 0;
    
    return `
      <div class="device-group ${signalClass}">
        <div class="group-header">
          <button class="group-toggle" data-group="${groupKey}">
            <span class="toggle-icon">${isExpanded ? '▼' : '▶'}</span>
            <span class="group-icon">${icon}</span>
            <span class="group-name">${escapeHtml(group.name)}</span>
            <span class="group-count">${group.deviceCount} device${group.deviceCount !== 1 ? 's' : ''}</span>
            <span class="group-signal">${range.max || '?'} / ${range.avg || '?'} / ${range.min || '?'} dBm</span>
            ${randomPct > 50 ? `<span class="group-hint">🔄 ${randomPct}% rotating MACs</span>` : ''}
          </button>
        </div>
        ${companionHtml}
        <div class="group-devices ${isExpanded ? '' : 'collapsed'}">
          ${(group.topDevices || []).map(td => `
            <div class="device-item mini-device">
              <div class="device-info">
                <div class="device-meta">${td.id.slice(0, 12)}... | ${td.rssi} dBm | ${td.lastSeen ? formatRelativeTime(td.lastSeen) : '?'}</div>
              </div>
            </div>
          `).join('')}
          ${group.deviceCount > 5 ? `<p class="section-note" style="text-align:center; padding: 0.3rem; color: #888;">Showing 5 of ${group.deviceCount} — individual MACs are ephemeral</p>` : ''}
        </div>
      </div>
    `;
  }
  
  let html = '';
  
  // 1. Individual devices (listed + unique named)
  for (const d of individuals) {
    html += renderDeviceItem(d);
  }
  
  // 2. Group summaries
  for (const g of groups) {
    html += renderGroupSummary(g);
  }
  
  if (!html) {
    html = '<p class="section-note">No devices yet</p>';
  }
  
  deviceList.innerHTML = html;
  updateSelectedCount();
}

// Toggle device group visibility (groups start collapsed)
function toggleDeviceGroup(groupKey) {
  if (expandedGroups.has(groupKey)) {
    expandedGroups.delete(groupKey);
  } else {
    expandedGroups.add(groupKey);
  }
  doRenderDevices(); // Direct call, no throttle needed for user action
}

// Toggle unknown devices visibility
function toggleUnknownDevices() {
  unknownCollapsed = !unknownCollapsed;
  renderDevices();
}

// Bulk action for a collapsible section (unknown devices, grouped devices)
async function bulkActionSection(listType, filterFn) {
  const devices = discoveredDevices
    .filter(filterFn)
    .map(d => ({ id: d.id, name: d.name }));
  
  if (devices.length === 0) return;
  
  const confirmMsg = `${listType === 'blacklist' ? 'Blacklist' : 'Greylist'} ${devices.length} devices?`;
  if (!confirm(confirmMsg)) return;
  
  lists = await window.api.bulkAddToList(devices, listType);
  renderDevices();
  renderList(listType);
}

// Event delegation for dynamically created elements (CSP blocks inline onclick)
deviceList.addEventListener('click', (e) => {
  // Handle bulk actions for sections
  const bulkActionBtn = e.target.closest('[data-bulk-action]');
  if (bulkActionBtn) {
    const action = bulkActionBtn.dataset.bulkAction;
    if (action === 'blacklist-unknown') {
      bulkActionSection('blacklist', d => (d.isUnknown || d.name === 'Unknown Device') && !lists.blacklist[d.id]);
    } else if (action === 'greylist-unknown') {
      bulkActionSection('greylist', d => (d.isUnknown || d.name === 'Unknown Device') && !lists.blacklist[d.id]);
    } else if (action.startsWith('blacklist-group-')) {
      const groupName = decodeURIComponent(action.replace('blacklist-group-', ''));
      bulkActionSection('blacklist', d => d.name === groupName && !lists.blacklist[d.id]);
    } else if (action.startsWith('greylist-group-')) {
      const groupName = decodeURIComponent(action.replace('greylist-group-', ''));
      bulkActionSection('greylist', d => d.name === groupName && !lists.blacklist[d.id]);
    }
    return;
  }
  
  // Handle group toggle
  const groupToggle = e.target.closest('.group-toggle');
  if (groupToggle) {
    const groupKey = groupToggle.dataset.group;
    if (groupKey) toggleDeviceGroup(groupKey);
    return;
  }
  
  // Handle unknown section toggle
  const unknownToggle = e.target.closest('.unknown-toggle');
  if (unknownToggle) {
    toggleUnknownDevices();
    return;
  }
  
  // Handle quick action buttons
  const quickBtn = e.target.closest('.quick-btn');
  if (quickBtn) {
    const deviceId = quickBtn.dataset.deviceId;
    const deviceName = quickBtn.dataset.deviceName;
    const listType = quickBtn.dataset.list;
    if (deviceId && listType) {
      addToList(deviceId, deviceName, listType);
    }
    return;
  }
  
  // Handle bulk selection (checkbox or device info area)
  if (bulkMode) {
    const checkbox = e.target.closest('.checkbox-wrapper');
    if (checkbox) {
      const deviceId = checkbox.dataset.deviceId;
      if (deviceId) toggleSelection(deviceId);
      return;
    }
    
    const deviceInfo = e.target.closest('.device-info');
    if (deviceInfo) {
      const deviceId = deviceInfo.dataset.deviceId;
      if (deviceId) toggleSelection(deviceId);
      return;
    }
  }
});

function renderList(listType) {
  const list = lists[listType] || {};
  const entries = Object.entries(list);
  const listEl = document.getElementById(`${listType}-list`);
  const countEl = document.getElementById(`${listType}-count`);
  
  countEl.textContent = entries.length;
  
  if (entries.length === 0) {
    const messages = {
      whitelist: 'No devices on whitelist. Add devices from Nearby Devices tab.',
      greylist: 'No devices on greylist.',
      blacklist: 'No devices blacklisted.'
    };
    listEl.innerHTML = `<p class="empty-state">${messages[listType]}</p>`;
    return;
  }
  
  listEl.innerHTML = entries.map(([id, device]) => {
    const lastSeen = device.lastSeen 
      ? new Date(device.lastSeen).toLocaleString() 
      : 'Never';
    
    // For whitelist/greylist, look up proximity + companion data from aggregated devices
    let proximityHtml = '';
    let companionHtml = '';
    if ((listType === 'whitelist' || listType === 'greylist') && device.online) {
      // Find this device's companion data from the current aggregated state
      const groups = discoveredDevices.filter(d => d.isGroup && d.companions);
      for (const group of groups) {
        const comp = group.companions?.[id];
        if (comp) {
          // Proximity
          if (comp.proximity) {
            const p = comp.proximity;
            proximityHtml = `
              <div class="device-proximity">
                📡 ${p.distanceLabel} · ${p.trendLabel} · ${p.rssi} dBm
              </div>
            `;
          }
          // Companions
          if (comp.topCompanions && comp.topCompanions.length > 0) {
            const topParts = comp.topCompanions.slice(0, 3).map(c => {
              const badge = c.isNew ? '🆕' : (c.isRegular ? '✅' : '');
              return `${badge} ${escapeHtml(c.name)} (${c.rssi}dBm)`;
            });
            companionHtml = `
              <div class="device-companions">
                👥 Nearby: ${topParts.join(' · ')}
              </div>
            `;
          }
          break;
        }
      }
    }
    
    // Simpler UI for blacklist - just show Unhide button
    if (listType === 'blacklist') {
      return `
        <div class="device-item">
          <div class="device-info">
            <div class="device-name">${escapeHtml(device.name)}</div>
            <div class="device-meta">ID: ${id.slice(0, 12)}... | Hidden on: ${new Date(device.addedAt || Date.now()).toLocaleDateString()}</div>
          </div>
          <div class="device-actions">
            <button class="btn btn-success btn-small" data-action="remove" data-id="${id}" data-list="blacklist">👁️ Unhide</button>
          </div>
        </div>
      `;
    }
    
    return `
      <div class="device-item ${device.online ? 'online' : ''}">
        <div class="device-status">
          <span class="status-indicator ${device.online ? 'online' : 'offline'}"></span>
        </div>
        <div class="device-info">
          <div class="device-name">
            <input type="text" value="${escapeHtml(device.name)}" 
              data-device-id="${id}" class="device-name-input"
              placeholder="Device name">
          </div>
          <div class="device-meta">ID: ${id.slice(0, 12)}... | Last seen: ${lastSeen}</div>
          ${proximityHtml}
          ${companionHtml}
        </div>
        <div class="device-actions">
          <div class="action-dropdown">
            <button class="btn btn-small btn-secondary dropdown-toggle">↔️ Move</button>
            <div class="dropdown-menu">
              ${listType !== 'whitelist' ? `<button data-action="move" data-id="${id}" data-from="${listType}" data-to="whitelist">🔔 To Whitelist</button>` : ''}
              ${listType !== 'greylist' ? `<button data-action="move" data-id="${id}" data-from="${listType}" data-to="greylist">📝 To Greylist</button>` : ''}
              ${listType !== 'blacklist' ? `<button data-action="move" data-id="${id}" data-from="${listType}" data-to="blacklist">🚫 To Blacklist</button>` : ''}
              <button data-action="remove" data-id="${id}" data-list="${listType}">❌ Remove</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Set up dropdown toggles for list view
  listEl.querySelectorAll('.dropdown-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      document.querySelectorAll('.dropdown-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
      });
      menu.classList.toggle('show');
    });
  });
  
  // Event delegation for list actions (move/remove buttons)
  listEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      
      if (action === 'move') {
        const from = btn.dataset.from;
        const to = btn.dataset.to;
        await moveToList(id, from, to);
      } else if (action === 'remove') {
        const list = btn.dataset.list;
        await removeFromList(id, list);
      }
      
      // Close dropdown
      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    });
  });
  
  // Device name change handlers
  listEl.querySelectorAll('.device-name-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const deviceId = input.dataset.deviceId;
      updateDeviceName(deviceId, input.value);
    });
  });
}

function formatSessionDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatSessionTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderActivityLog() {
  if (!activityLog || activityLog.length === 0) {
    activityLogEl.innerHTML = '<p class="empty-state">No activity recorded yet. Whitelist or greylist devices to start tracking.<br><small>Non-listed devices appear as nested companions under whitelisted devices they\'re near.</small></p>';
    return;
  }
  
  // Only show named whitelist/greylist entries — generic devices (Apple Device, Unknown Device)
  // and non-listed devices appear as nested companions, not top-level entries
  const genericNames = ['Apple Device', 'Unknown Device', 'Samsung Device', 'Google Device', 'Microsoft Device'];
  const allEntries = activityLog.filter(e => {
    if (e.listType !== 'whitelist' && e.listType !== 'greylist') return false;
    return !genericNames.includes(e.deviceName);
  });
  
  if (allEntries.length === 0) {
    const totalRaw = activityLog.length;
    const msg = totalRaw > 0 
      ? `<p class="empty-state">${totalRaw} events from generic/non-listed devices filtered out.<br>Only named whitelisted/greylisted device activity shown here.<br><small>Generic devices (Apple Device, etc.) appear as companions when near a named device.</small></p>`
      : '<p class="empty-state">No activity recorded yet. Whitelist or greylist devices to start tracking.</p>';
    activityLogEl.innerHTML = msg;
    return;
  }
  
  // Sort: active sessions first, then by most recent end time / timestamp
  const sorted = allEntries.slice(0, 50).sort((a, b) => {
    const aActive = !a.endTime && (a.status === 'online' || a.status === 'unstable');
    const bActive = !b.endTime && (b.status === 'online' || b.status === 'unstable');
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    // Both same type - sort by most recent
    const aTime = a.endTime || a.lastUpdate || a.timestamp;
    const bTime = b.endTime || b.lastUpdate || b.timestamp;
    return bTime - aTime;
  });
  
  activityLogEl.innerHTML = sorted.map(entry => {
    const listIcon = entry.listType === 'whitelist' ? '🔔' : (entry.listType === 'greylist' ? '📝' : '📱');
    const startTime = formatSessionTime(entry.timestamp);
    const isSession = !!entry.sessionId;
    const isActive = !entry.endTime && (entry.status === 'online' || entry.status === 'unstable');
    const isUnstable = (entry.dropouts || 0) > 0;
    
    if (isSession) {
      // Session entry: show time range + duration
      const endTimeStr = entry.endTime ? formatSessionTime(entry.endTime) : (isActive ? 'now' : '?');
      const durationMs = entry.duration || ((entry.endTime || Date.now()) - entry.timestamp);
      const durationStr = formatSessionDuration(durationMs);
      
      let sessionClass = 'session-complete';
      if (isActive) {
        sessionClass = isUnstable ? 'session-unstable' : 'session-active';
      } else if (isUnstable) {
        sessionClass = 'session-unstable';
      }
      
      const locationHtml = entry.locationName ? `<span class="log-location">📍 ${escapeHtml(entry.locationName)}</span>` : '';
      const statusHtml = isActive ? '<span class="log-status online">● Online</span>' : '';
      const dropoutsHtml = isUnstable ? `<span class="log-dropouts">⚠ ${entry.dropouts} dropout${entry.dropouts > 1 ? 's' : ''}</span>` : '';
      const tooltipAttr = entry.summary ? `title="${escapeHtml(entry.summary)}"` : '';
      
      // Movement detection — did this device change location or companions?
      let movementHtml = '';
      if (entry.movement?.moved) {
        const badge = entry.movement.inferredMovement 
          ? '<span class="movement-badge inferred">🔀 Companions changed</span>'
          : `<span class="movement-badge">🚚 Moved from ${escapeHtml(entry.movement.fromLocation)} → ${escapeHtml(entry.movement.toLocation)}</span>`;
        let details = '';
        if (entry.movement.traveledWith?.length > 0) {
          details += `<div class="movement-detail">🧳 Traveled with: ${entry.movement.traveledWith.map(c => escapeHtml(c.deviceName)).join(', ')}</div>`;
        }
        if (entry.movement.leftBehind?.length > 0) {
          details += `<div class="movement-detail faded">📍 Left behind: ${entry.movement.leftBehind.map(c => escapeHtml(c.deviceName)).join(', ')}</div>`;
        }
        if (entry.movement.newCompanions?.length > 0) {
          details += `<div class="movement-detail new">🆕 New companions: ${entry.movement.newCompanions.map(c => escapeHtml(c.deviceName)).join(', ')}</div>`;
        }
        movementHtml = `<div class="log-movement">${badge}${details}</div>`;
      }
      
      // Companion devices — who's using this device (phones, tablets nearby)
      let companionHtml = '';
      if (entry.companions && entry.companions.length > 0) {
        const companionItems = entry.companions.map(c => {
          const label = c.isNew ? '🆕 new' : (c.isRegular ? `✅ regular (${c.seenTogetherCount}x)` : `seen ${c.seenTogetherCount}x`);
          const distLabel = c.distance ? ` ~${c.distance.toFixed(1)}m` : '';
          const alertClass = c.isNew ? ' companion-new' : (c.isRegular ? ' companion-regular' : '');
          return `<div class="companion-item${alertClass}">📱 ${escapeHtml(c.deviceName)} <span class="companion-meta">(${c.rssi} dBm${distLabel}, ${label})</span></div>`;
        });
        companionHtml = `<div class="log-companions"><div class="companions-label">👤 Using this device:</div>${companionItems.join('')}</div>`;
      }
      
      // Unusual nearby — legacy alert for unknown devices
      let nearbyHtml = '';
      if (entry.nearbyUnusual && entry.nearbyUnusual.length > 0 && !entry.companions) {
        const nearbyParts = entry.nearbyUnusual.map(d => {
          const label = d.seenTogetherCount === 0 ? 'never seen before' :
                        d.seenTogetherCount === 1 ? 'seen once before' :
                        `seen ${d.seenTogetherCount}x before`;
          return `<span class="nearby-device">${escapeHtml(d.deviceName)}</span> (${d.rssi} dBm, ${label})`;
        });
        nearbyHtml = `<div class="log-nearby">👀 Unusual nearby: ${nearbyParts.join(' · ')}</div>`;
      }

      return `
        <div class="log-item ${sessionClass}" ${tooltipAttr}>
          ${listIcon}
          <span class="log-device">${escapeHtml(entry.deviceName)}</span>
          <span class="log-session-time">${startTime} → ${endTimeStr}</span>
          <span class="log-duration">(${durationStr})</span>
          ${statusHtml}
          ${dropoutsHtml}
          ${locationHtml}
        </div>
        ${movementHtml}
        ${companionHtml}
        ${nearbyHtml}
      `;
    } else {
      // Standalone event: simple one-liner
      const eventIcon = entry.event === 'online' ? '🟢' : (entry.event === 'offline' ? '🔴' : '⚪');
      const summaryText = entry.summary || `${entry.deviceName} ${entry.event || 'unknown'}`;
      
      return `
        <div class="log-item log-event">
          ${listIcon} ${eventIcon}
          <span class="log-device">${escapeHtml(entry.deviceName)}</span>
          <span class="log-event-text">${escapeHtml(entry.event || '')} at ${startTime}</span>
        </div>
      `;
    }
  }).join('');
}

// Update active session durations every 30 seconds
setInterval(() => {
  const hasActiveSessions = activityLog.some(e => !e.endTime && (e.status === 'online' || e.status === 'unstable'));
  if (hasActiveSessions) {
    renderActivityLog();
  }
}, 30000);

function renderLocations() {
  // Update current location display
  const locName = currentLocation?.name || (currentLocation?.coords 
    ? `${currentLocation.coords.city || 'Unknown'}, ${currentLocation.coords.country || ''}`
    : 'Unknown');
  currentLocationName.textContent = locName;
  
  // Show coordinates instead of WiFi
  const coords = currentLocation?.coords;
  currentWifiEl.textContent = coords 
    ? `🌍 ${coords.lat?.toFixed(4)}, ${coords.lon?.toFixed(4)}` 
    : '🌍 No coordinates';
  
  if (!locations || locations.length === 0) {
    locationListEl.innerHTML = `
      <p class="empty-state">No locations saved yet.</p>
      ${coords ? `<p class="hint">You're at ${coords.city || 'an unknown location'}. Click "Save Current Location" to remember this place.</p>` : ''}
    `;
    return;
  }
  
  locationListEl.innerHTML = locations.map(loc => {
    const isCurrent = currentLocation?.id === loc.id;
    const coordsStr = loc.lat && loc.lon 
      ? `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}` 
      : 'No coordinates';
    const radiusStr = `${loc.radiusKm || 5}km radius`;
    
    return `
      <div class="location-item ${isCurrent ? 'current' : ''}">
        <div class="location-info">
          <div class="location-name">
            ${isCurrent ? '📍 ' : ''}${escapeHtml(loc.name)}
            ${isCurrent ? '<span class="current-badge">Current</span>' : ''}
          </div>
          <div class="location-coords">🌍 ${coordsStr} · ${radiusStr}</div>
        </div>
        <div class="location-actions">
          ${!isCurrent ? `<button class="btn btn-small btn-primary" data-loc-action="set" data-loc-id="${loc.id}">Set Current</button>` : ''}
          <button class="btn btn-small btn-secondary" data-loc-action="radius" data-loc-id="${loc.id}" data-radius="${loc.radiusKm || 5}">📏 Radius</button>
          <button class="btn btn-small btn-danger" data-loc-action="remove" data-loc-id="${loc.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
  
  // Event delegation for location buttons
  locationListEl.querySelectorAll('[data-loc-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.locAction;
      const locId = btn.dataset.locId;
      
      if (action === 'set') {
        await setLocation(locId);
      } else if (action === 'radius') {
        const currentRadius = parseFloat(btn.dataset.radius);
        await editLocationRadius(locId, currentRadius);
      } else if (action === 'remove') {
        await removeLocation(locId);
      }
    });
  });
}

async function setLocation(locationId) {
  const result = await window.api.setLocation(locationId);
  currentLocation = result;
  renderLocations();
}

async function editLocationRadius(locationId, currentRadius) {
  const newRadius = prompt(`Set radius in km (current: ${currentRadius}km):`, currentRadius);
  if (newRadius === null) return;
  
  const radius = parseFloat(newRadius);
  if (isNaN(radius) || radius <= 0) {
    alert('Please enter a valid positive number');
    return;
  }
  
  locations = await window.api.updateLocation({ id: locationId, radiusKm: radius });
  renderLocations();
}

async function removeLocation(locationId) {
  if (!confirm('Delete this location?')) return;
  locations = await window.api.removeLocation(locationId);
  // Refresh current location state
  currentLocation = await window.api.getCurrentLocation();
  renderLocations();
}

async function refreshLocation() {
  currentLocation = await window.api.refreshLocation();
  locations = await window.api.getLocations();
  renderLocations();
}

// Make location functions global
window.setLocation = setLocation;
window.editLocationRadius = editLocationRadius;
window.removeLocation = removeLocation;
window.refreshLocation = refreshLocation;

// Selection for bulk mode
function toggleSelection(deviceId) {
  if (selectedDevices.has(deviceId)) {
    selectedDevices.delete(deviceId);
  } else {
    selectedDevices.add(deviceId);
  }
  renderDevices();
}

function updateSelectedCount() {
  selectedCountEl.textContent = `${selectedDevices.size} selected`;
}

// Actions
async function addToList(deviceId, deviceName, listType) {
  console.log(`[ADD TO LIST] deviceId=${deviceId}, deviceName=${deviceName}, listType=${listType}`);
  
  // IMMEDIATELY remove from local array if blacklisting
  if (listType === 'blacklist') {
    discoveredDevices = discoveredDevices.filter(d => d.id !== deviceId);
    // Also add to local blacklist immediately
    lists.blacklist[deviceId] = { name: deviceName, addedAt: Date.now() };
    doRenderDevices();
    updateTabBadges();
    renderList('blacklist');
  }
  
  // Then do the API call
  try {
    console.log('[API CALL] Calling window.api.addToList...');
    const result = await window.api.addToList(deviceId, deviceName, listType);
    console.log('[API RESULT]', result);
  } catch (e) {
    console.error('[API ERROR] addToList failed:', e);
    alert(`Error saving to ${listType}: ${e}`);
    return; // Don't continue if save failed
  }
  
  // Refresh lists from backend to confirm save
  console.log('[REFRESH] Getting fresh lists from backend...');
  lists = await window.api.getLists();
  console.log('[REFRESH RESULT] Blacklist now has:', Object.keys(lists.blacklist || {}).length, 'devices');
  console.log('[REFRESH RESULT] Blacklist contents:', lists.blacklist);
  
  updateTabBadges();
  doRenderDevices();
  renderList(listType);
}

async function removeFromList(deviceId, listType) {
  const result = await window.api.removeFromList(deviceId, listType);
  // Force refresh
  lists = await window.api.getLists();
  updateTabBadges();
  doRenderDevices();
  renderList(listType);
}

async function moveToList(deviceId, fromList, toList) {
  const result = await window.api.moveToList(deviceId, fromList, toList);
  // Force refresh
  lists = await window.api.getLists();
  updateTabBadges();
  renderList(fromList);
  renderList(toList);
  doRenderDevices();
}

async function bulkAddToList(listType) {
  if (selectedDevices.size === 0) return;
  
  // Get individual devices only (not groups)
  const devices = discoveredDevices
    .filter(d => selectedDevices.has(d.id) && !d.isGroup)
    .map(d => ({ id: d.id, name: d.name }));
  
  if (devices.length === 0) {
    alert('No individual devices selected. Groups cannot be bulk-added.');
    return;
  }
  
  console.log(`Bulk adding ${devices.length} devices to ${listType}:`, devices);
  
  await window.api.bulkAddToList(devices, listType);
  
  // Force refresh lists from backend
  lists = await window.api.getLists();
  console.log('Fresh lists after bulk:', lists);
  console.log('Blacklist now has:', Object.keys(lists.blacklist || {}).length, 'items');
  
  // Exit bulk mode
  bulkMode = false;
  selectedDevices.clear();
  bulkActions.classList.add('hidden');
  toggleBulkBtn.textContent = '☑️ Bulk Select';
  toggleBulkBtn.classList.remove('btn-primary');
  toggleBulkBtn.classList.add('btn-secondary');
  
  // Force full UI refresh
  updateTabBadges();
  doRenderDevices();
  renderList(listType);
}

async function updateDeviceName(deviceId, name) {
  lists = await window.api.updateDeviceName(deviceId, name);
}

// Utility
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || 'Unknown';
  return div.innerHTML;
}

// Make functions global for onclick handlers
window.toggleSelection = toggleSelection;
window.addToList = addToList;
window.removeFromList = removeFromList;
window.moveToList = moveToList;
window.updateDeviceName = updateDeviceName;

// Start the app - wait for Tauri bridge to be ready
function startApp() {
  if (window.api) {
    init();
  } else {
    console.log('Waiting for Tauri bridge...');
    window.addEventListener('tauri-bridge-ready', init, { once: true });
  }
}

// Wait for DOM ready, then start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
