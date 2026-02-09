/**
 * Bluetooth Scanner API Server
 * 
 * Exposes the Bluetooth scanner state via HTTP for Mission Control web interface.
 * Runs alongside the Electron app on port 9920.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const API_PORT = 9920;
let LOG_DIR = null; // Set by initApiServer

let app = null;
let server = null;
let scannerState = {
  store: null,
  discoveredDevices: null,
  deviceStates: null,
  isScanning: false,
  noble: null,
  currentLocation: null,
  currentCoords: null
};

/**
 * Initialize the API server with references to scanner state
 */
function initApiServer(state) {
  scannerState = { ...scannerState, ...state };
  LOG_DIR = state.logDir || null;
  
  app = express();
  app.use(cors());
  app.use(express.json());
  
  // ============================================================
  // STATUS & INFO
  // ============================================================
  
  app.get('/api/status', (req, res) => {
    res.json({
      scanning: scannerState.isScanning,
      bluetoothState: scannerState.noble?.state || 'unknown',
      deviceCount: scannerState.discoveredDevices?.size || 0,
      location: scannerState.currentLocation,
      coords: scannerState.currentCoords,
      uptime: process.uptime()
    });
  });
  
  // ============================================================
  // DEVICES
  // ============================================================
  
  app.get('/api/devices', (req, res) => {
    const deviceOrder = scannerState.store?.get('deviceOrder') || [];
    const devices = Array.from(scannerState.discoveredDevices?.values() || []);
    
    // Sort by discovery order (stable)
    const sorted = devices.sort((a, b) => {
      const aIdx = deviceOrder.indexOf(a.id);
      const bIdx = deviceOrder.indexOf(b.id);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    
    res.json(sorted);
  });
  
  app.get('/api/devices/:id', (req, res) => {
    const device = scannerState.discoveredDevices?.get(req.params.id);
    if (device) {
      res.json(device);
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  });
  
  // ============================================================
  // LISTS (Whitelist, Greylist, Blacklist)
  // ============================================================
  
  app.get('/api/lists', (req, res) => {
    res.json(scannerState.store?.get('lists') || {});
  });
  
  app.get('/api/lists/:type', (req, res) => {
    const lists = scannerState.store?.get('lists') || {};
    const listType = req.params.type;
    if (['whitelist', 'greylist', 'blacklist'].includes(listType)) {
      res.json(lists[listType] || {});
    } else {
      res.status(400).json({ error: 'Invalid list type' });
    }
  });
  
  app.post('/api/lists/:type', (req, res) => {
    const { deviceId, deviceName } = req.body;
    const listType = req.params.type;
    
    if (!['whitelist', 'greylist', 'blacklist'].includes(listType)) {
      return res.status(400).json({ error: 'Invalid list type' });
    }
    
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId required' });
    }
    
    const lists = scannerState.store?.get('lists') || {};
    
    // Remove from other lists first
    delete lists.blacklist[deviceId];
    delete lists.greylist[deviceId];
    delete lists.whitelist[deviceId];
    
    // Check if device is currently being detected
    const isCurrentlyDetected = scannerState.discoveredDevices?.has(deviceId);
    const now = Date.now();
    
    // Add to specified list
    lists[listType][deviceId] = {
      name: deviceName || 'Unknown Device',
      addedAt: now,
      lastSeen: isCurrentlyDetected ? now : null,
      online: isCurrentlyDetected && (listType === 'whitelist' || listType === 'greylist')
    };
    
    scannerState.store?.set('lists', lists);
    
    // If adding to whitelist/greylist and device is currently detected, 
    // update deviceStates and log the activity
    if (isCurrentlyDetected && (listType === 'whitelist' || listType === 'greylist')) {
      // Update device states
      scannerState.deviceStates?.set(deviceId, { online: true, lastSeen: now });
      
      // Log activity - device just came "online" to tracking
      const activityLog = scannerState.store?.get('activityLog') || [];
      const locations = scannerState.store?.get('locations') || [];
      const currentLocation = scannerState.currentLocation;
      const locInfo = locations.find(l => l.id === currentLocation);
      
      activityLog.unshift({
        timestamp: now,
        deviceId,
        deviceName: deviceName || 'Unknown Device',
        event: 'online',
        listType,
        location: currentLocation,
        locationName: locInfo?.name || currentLocation
      });
      
      // Keep last 1000 entries
      if (activityLog.length > 1000) {
        activityLog.length = 1000;
      }
      
      scannerState.store?.set('activityLog', activityLog);
      
      // Broadcast the activity update via SSE
      if (app.broadcastEvent) {
        app.broadcastEvent('activity', activityLog[0]);
      }
      
      console.log(`[API] Device ${deviceName || deviceId} added to ${listType} and logged as online`);
    }
    
    res.json({ success: true, lists, logged: isCurrentlyDetected });
  });
  
  app.delete('/api/lists/:type/:deviceId', (req, res) => {
    const { type: listType, deviceId } = req.params;
    
    if (!['whitelist', 'greylist', 'blacklist'].includes(listType)) {
      return res.status(400).json({ error: 'Invalid list type' });
    }
    
    const lists = scannerState.store?.get('lists') || {};
    if (lists[listType]) {
      delete lists[listType][deviceId];
      scannerState.store?.set('lists', lists);
    }
    
    scannerState.deviceStates?.delete(deviceId);
    res.json({ success: true, lists });
  });
  
  // ============================================================
  // SCANNING CONTROL
  // ============================================================
  
  app.post('/api/scanning/start', (req, res) => {
    if (scannerState.startScanning) {
      scannerState.startScanning();
      res.json({ success: true, scanning: true });
    } else {
      res.status(500).json({ error: 'Scanner not initialized' });
    }
  });
  
  app.post('/api/scanning/stop', (req, res) => {
    if (scannerState.stopScanning) {
      scannerState.stopScanning();
      res.json({ success: true, scanning: false });
    } else {
      res.status(500).json({ error: 'Scanner not initialized' });
    }
  });
  
  // ============================================================
  // LOCATIONS
  // ============================================================
  
  app.get('/api/locations', (req, res) => {
    res.json({
      locations: scannerState.store?.get('locations') || [],
      current: scannerState.currentLocation,
      coords: scannerState.currentCoords
    });
  });
  
  app.post('/api/locations', (req, res) => {
    const { name, lat, lon, radiusKm } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }
    
    const locations = scannerState.store?.get('locations') || [];
    const id = `loc-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    
    const useLat = lat ?? scannerState.currentCoords?.lat;
    const useLon = lon ?? scannerState.currentCoords?.lon;
    
    if (useLat && useLon) {
      const newLoc = { id, name, lat: useLat, lon: useLon, radiusKm: radiusKm || 5 };
      locations.push(newLoc);
      scannerState.store?.set('locations', locations);
      res.json({ success: true, location: newLoc, locations });
    } else {
      res.status(400).json({ error: 'No coordinates available' });
    }
  });
  
  // ============================================================
  // ACTIVITY LOG (Aggregated, Human-Readable)
  // ============================================================
  
  app.get('/api/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const deviceId = req.query.deviceId;
    const status = req.query.status; // online, offline, unstable
    const raw = req.query.raw === 'true';
    const unfiltered = req.query.unfiltered === 'true';
    
    let log = scannerState.store?.get('activityLog') || [];
    
    // Default: only show named whitelist/greylist devices
    // Generic devices (Apple Device, Unknown Device etc.) only appear as companions
    // Use ?unfiltered=true to bypass for debugging
    if (!unfiltered) {
      const genericNames = ['Apple Device', 'Unknown Device', 'Samsung Device', 'Google Device', 'Microsoft Device'];
      log = log.filter(e => {
        if (e.listType !== 'whitelist' && e.listType !== 'greylist') return false;
        return !genericNames.includes(e.deviceName);
      });
    }
    
    // Filter by device if specified
    if (deviceId) {
      log = log.filter(e => e.deviceId === deviceId);
    }
    
    // Filter by status if specified
    if (status) {
      log = log.filter(e => e.status === status);
    }
    
    const totalFiltered = log.length;
    
    // Return limited entries
    const entries = log.slice(0, limit);
    
    // If raw=true, return as-is for debugging
    if (raw) {
      return res.json(entries);
    }
    
    // Return formatted — single source of truth for both MC web view and Electron
    res.json({
      count: entries.length,
      total: totalFiltered,
      entries: entries.map(e => ({
        timestamp: e.timestamp,
        time: new Date(e.timestamp).toLocaleString('en-GB'),
        deviceName: e.deviceName,
        deviceId: e.deviceId,
        sessionId: e.sessionId || null,
        event: e.event,
        status: e.status,
        summary: e.summary || `${e.deviceName} ${e.event}`,
        duration: e.duration ? formatDuration(e.duration) : null,
        dropouts: e.dropouts || 0,
        location: e.locationName,
        listType: e.listType || null,
        companions: e.companions || null,
        nearbyUnusual: e.nearbyUnusual || null,
        endTime: e.endTime || null,
        movement: e.movement || null
      }))
    });
  });
  
  // Get activity summary per device
  app.get('/api/activity/summary', (req, res) => {
    const log = scannerState.store?.get('activityLog') || [];
    const hours = parseInt(req.query.hours) || 24;
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    
    // Group by device
    const deviceSummaries = {};
    
    for (const entry of log) {
      if (entry.timestamp < cutoff) continue;
      
      if (!deviceSummaries[entry.deviceId]) {
        deviceSummaries[entry.deviceId] = {
          deviceId: entry.deviceId,
          deviceName: entry.deviceName,
          sessions: 0,
          totalOnlineTime: 0,
          totalDropouts: 0,
          lastSeen: null,
          currentStatus: null
        };
      }
      
      const summary = deviceSummaries[entry.deviceId];
      
      if (entry.sessionId) {
        summary.sessions++;
        if (entry.duration) summary.totalOnlineTime += entry.duration;
        if (entry.dropouts) summary.totalDropouts += entry.dropouts;
      }
      
      if (!summary.lastSeen || entry.timestamp > summary.lastSeen) {
        summary.lastSeen = entry.timestamp;
        summary.currentStatus = entry.status;
      }
    }
    
    // Format for output
    const summaries = Object.values(deviceSummaries).map(s => ({
      device: s.deviceName,
      sessions: s.sessions,
      totalOnline: s.totalOnlineTime ? formatDuration(s.totalOnlineTime) : '0',
      dropouts: s.totalDropouts,
      lastSeen: s.lastSeen ? new Date(s.lastSeen).toLocaleString('en-GB') : null,
      status: s.currentStatus,
      reliability: s.totalDropouts === 0 ? 'stable' : 
                   s.totalDropouts < 5 ? 'minor issues' : 'unstable'
    }));
    
    res.json({
      period: `Last ${hours} hours`,
      devices: summaries.sort((a, b) => (b.sessions || 0) - (a.sessions || 0))
    });
  });
  
  app.delete('/api/activity', (req, res) => {
    scannerState.store?.set('activityLog', []);
    res.json({ success: true });
  });
  
  // Migrate/aggregate old log entries into session format
  app.post('/api/activity/aggregate', (req, res) => {
    const oldLog = scannerState.store?.get('activityLog') || [];
    if (oldLog.length === 0) {
      return res.json({ message: 'No entries to aggregate', count: 0 });
    }
    
    // Check if already migrated (new entries have sessionId or summary)
    const alreadyMigrated = oldLog.some(e => e.sessionId || e.summary?.includes('→'));
    if (alreadyMigrated && !req.query.force) {
      return res.json({ message: 'Already migrated. Use ?force=true to re-run', count: oldLog.length });
    }
    
    // Group entries by device, sorted by time (oldest first)
    const byDevice = {};
    const sortedOld = [...oldLog].sort((a, b) => a.timestamp - b.timestamp);
    
    for (const entry of sortedOld) {
      if (!byDevice[entry.deviceId]) byDevice[entry.deviceId] = [];
      byDevice[entry.deviceId].push(entry);
    }
    
    // Process each device's events into sessions
    const FLAP_THRESHOLD = 60000; // 1 minute
    const newLog = [];
    
    for (const [deviceId, events] of Object.entries(byDevice)) {
      let currentSession = null;
      
      for (const event of events) {
        if (event.event === 'online') {
          if (currentSession && currentSession.endTime && 
              (event.timestamp - currentSession.endTime) < FLAP_THRESHOLD) {
            // Quick reconnect - count as dropout
            currentSession.dropouts = (currentSession.dropouts || 0) + 1;
            currentSession.endTime = null;
          } else {
            // New session
            if (currentSession) {
              // Finalize previous session
              finalizeSession(currentSession, newLog);
            }
            currentSession = {
              sessionId: `migrated-${event.timestamp}-${deviceId.slice(0, 6)}`,
              deviceId,
              deviceName: event.deviceName,
              startTime: event.timestamp,
              endTime: null,
              dropouts: 0,
              location: event.location,
              locationName: event.locationName,
              listType: event.listType
            };
          }
        } else if (event.event === 'offline' && currentSession) {
          currentSession.endTime = event.timestamp;
        }
      }
      
      // Finalize last session for this device
      if (currentSession) {
        finalizeSession(currentSession, newLog);
      }
    }
    
    // Sort by timestamp descending (newest first)
    newLog.sort((a, b) => b.timestamp - a.timestamp);
    
    // Save migrated log
    scannerState.store?.set('activityLog', newLog);
    
    res.json({ 
      message: 'Migrated successfully',
      oldCount: oldLog.length,
      newCount: newLog.length,
      reduction: `${Math.round((1 - newLog.length / oldLog.length) * 100)}%`
    });
  });
  
  function finalizeSession(session, log) {
    const duration = session.endTime ? session.endTime - session.startTime : null;
    const isUnstable = session.dropouts >= 3;
    
    const formatTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    
    let summary = session.deviceName;
    if (duration) {
      summary += ` online ${formatDuration(duration)}`;
      summary += ` (${formatTime(session.startTime)} → ${formatTime(session.endTime)})`;
    } else {
      summary += ` came online at ${formatTime(session.startTime)}`;
    }
    
    if (session.dropouts > 0) {
      summary += isUnstable 
        ? ` ⚠️ connection unstable (${session.dropouts} dropouts)` 
        : ` • ${session.dropouts} brief dropout${session.dropouts > 1 ? 's' : ''}`;
    }
    
    if (session.locationName) {
      summary += ` @ ${session.locationName}`;
    }
    
    log.push({
      timestamp: session.endTime || session.startTime,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      event: session.endTime ? 'session_end' : 'session_start',
      status: session.endTime ? (isUnstable ? 'unstable' : 'offline') : 'online',
      listType: session.listType,
      location: session.location,
      locationName: session.locationName,
      dropouts: session.dropouts,
      duration,
      startTime: session.startTime,
      endTime: session.endTime,
      summary
    });
  }
  
  // Helper for duration formatting
  function formatDuration(ms) {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
    const hours = Math.floor(ms / 3600000);
    const mins = Math.round((ms % 3600000) / 60000);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  
  // ============================================================
  // SETTINGS
  // ============================================================
  
  app.get('/api/settings', (req, res) => {
    res.json(scannerState.store?.get('settings') || {});
  });
  
  app.patch('/api/settings', (req, res) => {
    const settings = scannerState.store?.get('settings') || {};
    Object.assign(settings, req.body);
    scannerState.store?.set('settings', settings);
    res.json(settings);
  });
  
  // ============================================================
  // LOGS (for debugging crashes)
  // ============================================================
  
  app.get('/api/logs', (req, res) => {
    if (!LOG_DIR) {
      return res.status(500).json({ error: 'Log directory not configured' });
    }
    try {
      const files = fs.existsSync(LOG_DIR) 
        ? fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'))
        : [];
      res.json({ 
        logDir: LOG_DIR,
        files: files.map(f => {
          const stats = fs.statSync(path.join(LOG_DIR, f));
          return { name: f, size: stats.size, modified: stats.mtime };
        })
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  app.get('/api/logs/:filename', (req, res) => {
    const { filename } = req.params;
    const lines = parseInt(req.query.lines) || 200;
    const logPath = path.join(LOG_DIR, filename);
    
    // Security: prevent directory traversal
    if (!filename.endsWith('.log') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    try {
      if (!fs.existsSync(logPath)) {
        return res.status(404).json({ error: 'Log file not found' });
      }
      
      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n');
      const tailLines = allLines.slice(-lines);
      
      res.json({
        filename,
        totalLines: allLines.length,
        lines: tailLines,
        truncated: allLines.length > lines
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  app.delete('/api/logs/:filename', (req, res) => {
    const { filename } = req.params;
    const logPath = path.join(LOG_DIR, filename);
    
    if (!filename.endsWith('.log') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  // ============================================================
  // COMPANION & PROXIMITY DATA
  // ============================================================
  
  // Get companion fingerprint for a whitelisted device
  app.get('/api/companions/:deviceId', (req, res) => {
    const history = scannerState.store?.get('companionHistory') || {};
    const devHistory = history[req.params.deviceId];
    
    if (!devHistory) {
      return res.json({ companions: [], message: 'No companion data yet' });
    }
    
    // Sort by count descending
    const companions = Object.entries(devHistory)
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => b.count - a.count);
    
    res.json({
      deviceId: req.params.deviceId,
      companions: companions,
      regularCount: companions.filter(c => c.count > 5).length,
      totalSeen: companions.length
    });
  });
  
  // Get aggregated device view (same as renderer sees)
  app.get('/api/devices/aggregated', (req, res) => {
    if (scannerState.getAggregatedDevices) {
      res.json(scannerState.getAggregatedDevices());
    } else {
      // Fallback to raw devices
      const devices = Array.from(scannerState.discoveredDevices?.values() || []);
      res.json(devices.slice(0, 50));
    }
  });
  
  // ============================================================
  // SERVER-SENT EVENTS (Real-time updates)
  // ============================================================
  
  const sseClients = new Set();
  
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
    
    sseClients.add(res);
    
    req.on('close', () => {
      sseClients.delete(res);
    });
  });
  
  // Export broadcast function for main process to use
  app.broadcastEvent = (eventType, data) => {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
      try {
        client.write(message);
      } catch (e) {
        sseClients.delete(client);
      }
    });
  };
  
  // Start server
  server = app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`[API] Bluetooth Scanner API running on http://0.0.0.0:${API_PORT}`);
  });
  
  return app;
}

/**
 * Update scanner state (called from main process)
 */
function updateState(updates) {
  scannerState = { ...scannerState, ...updates };
}

/**
 * Stop the API server
 */
function stopApiServer() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  initApiServer,
  updateState,
  stopApiServer,
  API_PORT
};
