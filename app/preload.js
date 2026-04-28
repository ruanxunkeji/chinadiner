const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Print the current page silently
  // options: { deviceName, copies, pageRanges }
  printSilent: (options) => ipcRenderer.invoke('print-silent', options),

  // Print a specific URL (useful for receipt pages)
  // options: { deviceName, copies, renderDelay, silent }
  printUrlSilent: (url, options) => ipcRenderer.invoke('print-url-silent', url, options),

  // Get available printers
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  // Check if running inside Electron
  isElectron: true,

  // Print raw text to a network printer by IP and port
  printToIp: (opts) => ipcRenderer.invoke('print-to-ip', opts),

  // Open the printer test window (used by long-press gesture)
  openPrinterTest: () => ipcRenderer.invoke('open-printer-test'),

  // Close the current window
  closeWindow: () => ipcRenderer.invoke('close-window'),
})
