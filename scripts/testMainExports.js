const path = require('path');
const os = require('os');
const fs = require('fs');

// Mock electron before any imports
class DummyBrowserWindow {
  constructor() {
    this.webContents = {
      setWindowOpenHandler: () => {},
      on: () => {},
      send: () => {}
    };
  }
  loadURL() {}
  loadFile() {}
  on() {}
  once() {}
  show() {}
  hide() {}
  close() {}
  destroy() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setFullScreenable() {}
  setContentProtection() {}
  setIgnoreMouseEvents() {}
  setFocusable() {}
  setSkipTaskbar() {}
}

const mockElectron = {
  app: {
    getPath: (name) => {
      if (name === 'userData') return 'C:\\Users\\shank\\AppData\\Roaming\\natively';
      return '';
    },
    getAppPath: () => 'V:\\Project\\Nat\\natively-cluely-ai-assistant',
    isPackaged: false,
    getName: () => 'natively',
    getVersion: () => '2.8.4',
    on: () => {},
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    dock: { hide: () => {}, show: () => {} },
    isReady: () => true
  },
  BrowserWindow: DummyBrowserWindow,
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
  shell: {},
  dialog: {},
  Menu: { buildFromTemplate: () => ({ setToolTip: () => {} }) },
  Tray: class {},
  nativeImage: { createFromPath: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (str) => Buffer.from(str),
    decryptString: (buf) => buf.toString()
  },
  globalShortcut: { register: () => {}, unregisterAll: () => {} },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
  },
  nativeTheme: {
    on: () => {},
    shouldUseDarkColors: false
  },
  systemPreferences: {
    on: () => {},
    subscribeNotification: () => {}
  }
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return mockElectron;
  }
  return originalLoad.apply(this, arguments);
};

process.env.NATIVELY_TEST_USERDATA = 'C:\\Users\\shank\\AppData\\Roaming\\natively';

const main = require('../dist-electron/electron/main.js');
console.log("=== MAIN EXPORTS ===");
console.log(Object.keys(main));
process.exit(0);
