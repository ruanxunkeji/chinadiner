const { app, BrowserWindow, ipcMain, Menu, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

function loadTargetUrl() {
  // 1. CLI flag: electron . --url=http://192.168.1.10:5173
  const urlArg = process.argv.find((a) => a.startsWith('--url='));
  if (urlArg) return urlArg.slice(6);

  // 2. config.json in userData folder
  const userDataConfigPath = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(userDataConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(userDataConfigPath, 'utf8'));
      if (config.url) return config.url;
    } catch {
      console.warn('Invalid config.json, using default URL');
    }
  }

  // 3. config.json next to the .exe (external override, takes priority over bundled)
  const exeDire = process.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const exeConfigPath = path.join(exeDire, 'config.json');
  if (fs.existsSync(exeConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(exeConfigPath, 'utf8'));
      if (config.url) return config.url;
    } catch {
      console.warn('Invalid config.json next to exe, trying bundled config');
    }
  }

  // 4. Fallback
  return 'http://localhost:5173';
}

const TARGET_URL = loadTargetUrl()

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    resizable: true,
    icon: path.join(__dirname, 'images', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.maximize()
  mainWindow.loadURL(TARGET_URL)

  // Remove default menu to keep it clean
  Menu.setApplicationMenu(null)

  // Inject long-press overlay in the top-left corner to open printer test
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('__printer-test-trigger')) return;
        const el = document.createElement('div');
        el.id = '__printer-test-trigger';
        Object.assign(el.style, {
          position: 'fixed', top: '0', left: '0',
          width: '30px', height: '30px',
          zIndex: '999999', opacity: '0',
          WebkitTapHighlightColor: 'transparent',
        });
        let timer = null;
        const start = () => { timer = setTimeout(() => { window.electronAPI.openPrinterTest(); }, 1500); };
        const cancel = () => clearTimeout(timer);
        el.addEventListener('touchstart', start);
        el.addEventListener('touchend', cancel);
        el.addEventListener('touchmove', cancel);
        el.addEventListener('mousedown', start);
        el.addEventListener('mouseup', cancel);
        el.addEventListener('mouseleave', cancel);
        document.body.appendChild(el);
      })();
    `)
  })
}

let printerTestWindow = null

function openPrinterTestWindow() {
  if (printerTestWindow && !printerTestWindow.isDestroyed()) {
    printerTestWindow.focus()
    return
  }
  printerTestWindow = new BrowserWindow({
    width: 600,
    height: 620,
    title: 'Printer Test',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  printerTestWindow.loadFile(path.join(__dirname, 'printer-test.html'))
  printerTestWindow.on('closed', () => { printerTestWindow = null })
}

app.whenReady().then(() => {
  createWindow()

  globalShortcut.register('CommandOrControl+Shift+Alt+P', openPrinterTestWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Parse a page dimension value into microns for Electron's print() API.
// Accepts numbers (treated as microns), or strings like "80mm", "8cm", "3in", "80000".
function parseMicrons(val) {
  if (val === undefined || val === null || val === '') return undefined
  if (typeof val === 'number') return val
  const s = String(val).trim().toLowerCase()
  if (s.endsWith('mm')) return Math.round(parseFloat(s) * 1000)
  if (s.endsWith('cm')) return Math.round(parseFloat(s) * 10000)
  if (s.endsWith('in')) return Math.round(parseFloat(s) * 25400)
  const n = parseFloat(s)
  return isNaN(n) ? undefined : Math.round(n)
}

function normalizePrintOptions(options) {
  const out = { ...options }
  if (out.pageSize && typeof out.pageSize === 'object' && !Array.isArray(out.pageSize)) {
    const w = parseMicrons(out.pageSize.width)
    const h = parseMicrons(out.pageSize.height)
    if (w || h) {
      out.pageSize = { ...(w ? { width: w } : {}), ...(h ? { height: h } : {}) }
    } else {
      delete out.pageSize
    }
  }
  return out
}

// Silent print: print the current page without showing a dialog
ipcMain.handle('print-silent', async (event, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return { success: false, reason: 'no window' }

  const opts = normalizePrintOptions(options)
  return new Promise((resolve) => {
    win.webContents.print(
      {
        silent: true,
        printBackground: true,
        margins: {
          marginType: 'none',
        },
        ...opts,
        deviceName: opts.deviceName || '',
        copies: opts.copies || 1,
      },
      (success, failureReason) => {
        resolve({ success, reason: failureReason || null });
      },
    );
  })
})

// Print a specific URL silently (e.g. a receipt page)
ipcMain.handle('print-url-silent', async (event, url, options = {}) => {
  const opts = normalizePrintOptions(options)
  return new Promise((resolve) => {
    let settled = false
    let tempFile = null

    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true },
    })

    const cleanup = () => {
      try { printWin.destroy() } catch {}
      if (tempFile) try { fs.unlinkSync(tempFile) } catch {}
    }

    const settle = (val) => {
      if (settled) return
      settled = true
      resolve(val)
      // Delay cleanup so the spooler can finish reading from the renderer
      // before the BrowserWindow is destroyed. The print callback fires as
      // soon as the job is handed to the OS spooler, not when it finishes.
      setTimeout(cleanup, 3000)
    }

    // Timeout safeguard: on Windows the print callback can silently never fire
    // (e.g. PDF printer waiting for a save dialog, or driver-level issues)
    const timeoutId = setTimeout(() => {
      console.warn('[print-url-silent] timed out waiting for print callback')
      settle({ success: false, reason: 'timeout' })
    }, 15000)

    // data: URLs can fail to fire load events on Windows — write to a temp file instead
    const dataPrefix = 'data:text/html;charset=utf-8,'
    if (url.startsWith(dataPrefix)) {
      tempFile = path.join(os.tmpdir(), `receipt-${Date.now()}.html`)
      fs.writeFileSync(tempFile, decodeURIComponent(url.slice(dataPrefix.length)), 'utf8')
      printWin.loadFile(tempFile)
    } else {
      printWin.loadURL(url)
    }

    // dom-ready fires more reliably than did-finish-load on Windows
    printWin.webContents.once('dom-ready', () => {
      // Delay to let the page finish rendering before printing
      setTimeout(() => {
        if (settled) return
        printWin.webContents.print(
          {
            silent: opts.silent !== false && opts.silent !== 'false',
            printBackground: true,
            margins: {
              marginType: 'none',
            },
            ...opts,
            deviceName: opts.deviceName || '',
            copies: opts.copies || 1
          },
          (success, failureReason) => {
            clearTimeout(timeoutId);
            if (failureReason)
              console.warn('[print-url-silent] failure:', failureReason);
            settle({ success, reason: failureReason || null });
          },
        );
      }, opts.renderDelay || 500)
    })
  })
})

// Open printer test window via touch gesture
ipcMain.handle('open-printer-test', () => {
  openPrinterTestWindow()
})

// Get list of available printers
ipcMain.handle('get-printers', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return []
  return win.webContents.getPrintersAsync()
})

ipcMain.handle('close-window', (event) => {
  app.quit()
})

// Print raw text to a network printer by IP and port (ESC/POS over TCP)
ipcMain.handle('print-to-ip', async (_event, { ip, port, text }) => {
  return new Promise((resolve) => {
    const net = require('net')
    const socket = net.createConnection({ host: ip, port: parseInt(port) || 9100 }, () => {
      const ESC = '\x1b'
      const GS = '\x1d'
      const init = ESC + '@'
      const cut = GS + 'V' + '\x41' + '\x00'
      const content = init + (text || '') + '\n\n\n\n' + cut
      socket.write(Buffer.from(content, 'binary'), () => {
        socket.destroy()
        resolve({ success: true, reason: null })
      })
    })
    socket.setTimeout(5000)
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ success: false, reason: 'timeout' })
    })
    socket.on('error', (err) => {
      resolve({ success: false, reason: err.message })
    })
  })
})
