# Bluetooth Beacon Scanner

A macOS Electron app that monitors Bluetooth devices and notifies you when whitelisted devices come online or go offline.

## Features

- **BLE Device Scanning**: Continuously scans for nearby Bluetooth Low Energy devices
- **Whitelist Management**: Add/remove devices you want to track
- **Desktop Notifications**: Get notified when whitelisted devices appear or disappear
- **Activity Log**: Track online/offline history for all whitelisted devices
- **Tray App**: Runs in the background with a menu bar icon
- **Configurable**: Adjust scan intervals and offline thresholds

## Installation

```bash
cd bluetooth-beacon
npm install
npm run rebuild  # Rebuild native modules for Electron
```

## Running

```bash
npm start
```

## Development

```bash
npm run dev  # Runs with NODE_ENV=development
```

## Tech Stack

- **Electron**: Desktop app framework
- **@abandonware/noble**: BLE scanning library
- **electron-store**: Persistent storage for settings/whitelist

## Project Structure

```
bluetooth-beacon/
├── package.json
├── src/
│   ├── main/
│   │   ├── main.js       # Main process (BT scanning, tray, notifications)
│   │   └── preload.js    # IPC bridge to renderer
│   └── renderer/
│       ├── index.html    # UI markup
│       ├── styles.css    # Styling
│       └── app.js        # UI logic
└── README.md
```

## Usage

1. **Start the app** - It will begin scanning automatically when Bluetooth is powered on
2. **Discover devices** - Go to "Nearby Devices" tab to see detected BLE devices
3. **Add to whitelist** - Click "Add to Whitelist" on devices you want to track
4. **Get notifications** - You'll be notified when whitelisted devices come online/offline
5. **View history** - Check the "Activity Log" tab for device presence history

## Permissions

On macOS, you may need to grant Bluetooth permissions when first running the app.

## Future Enhancements

- Classic Bluetooth support (not just BLE)
- Distance estimation based on RSSI
- Scheduled scanning windows
- Export activity log
- Webhook/API integration

---

Part of the EmberNest ecosystem boilerplate.
