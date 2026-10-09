// The Duct island: a transparent always-on-top window hugging the MacBook notch (or the top centre of the
// screen elsewhere). The page (/island, src/island.ts) draws the shapes; this module places the window, lets
// clicks through everywhere except where the island is drawn, and relays the cursor and keyboard focus.
const { BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('fs')
const path = require('path')

const WIDTH = 560
const HEIGHT = 460
const POLL_MS = 50
const NOTCH_WIDTH = 200

/**
 * macOS doesn't tell Electron where the notch is. Notched MacBooks have a taller menu bar on the built-in
 * display (about 37-38 pt, versus 24-30 pt without a notch), so that is the signal used here.
 */
function screenMetrics(display) {
  const menuBar = Math.max(0, display.workArea.y - display.bounds.y)
  const isMac = process.platform === 'darwin'
  const hasNotch = isMac && display.internal && menuBar >= 34
  return { bar: isMac ? menuBar : 0, notch: hasNotch ? NOTCH_WIDTH : 0 }
}

function createIsland({ serverUrl, onShowMain, onAddFiles, onWatchFolders, isSupportedFile, isPackage, sound = true, hello = false, shortcut = '' }) {
  let win = null
  let shape = null
  let inside = false
  let timer = null
  let metrics = null
  let lastCursor = ''

  function frameFor(display) {
    return { x: Math.round(display.bounds.x + display.bounds.width / 2 - WIDTH / 2), y: display.bounds.y, width: WIDTH, height: HEIGHT }
  }

  function load() {
    const display = screen.getPrimaryDisplay()
    metrics = screenMetrics(display)
    win.loadURL(`${serverUrl}/island?notch=${metrics.notch}&bar=${metrics.bar}&platform=${process.platform}&sound=${sound ? 1 : 0}&hello=${hello ? 1 : 0}&shortcut=${encodeURIComponent(shortcut)}`)
    hello = false
  }

  function create() {
    const display = screen.getPrimaryDisplay()
    win = new BrowserWindow({
      ...frameFor(display),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      // On macOS a panel can take keyboard input for the search box without bringing Duct's main window forward.
      ...(process.platform === 'darwin' ? { type: 'panel', enableLargerThanScreen: true } : {}),
      webPreferences: {
        // Sounds answer clicks and drops, but the first-launch hello plays before any click.
        autoplayPolicy: 'no-user-gesture-required',
        preload: path.join(__dirname, 'island-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.once('ready-to-show', () => {
      win.showInactive()
      // macOS keeps panels below the menu bar when they are created; moving it after showing puts it in the notch.
      win.setBounds(frameFor(screen.getPrimaryDisplay()))
    })
    win.on('closed', () => { win = null })
    load()
    timer = setInterval(track, POLL_MS)
  }

  // Clicks pass through the window except over the drawn island, so the menu bar and apps below keep working.
  // The cursor is polled (rather than relying on mouse events) so hover also works while dragging files.
  function track() {
    if (!win || win.isDestroyed() || !shape) return
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    // The mascot's eyes follow the cursor, so the page gets its position relative to the window.
    const cursor = `${point.x - bounds.x},${point.y - bounds.y}`
    if (cursor !== lastCursor) {
      lastCursor = cursor
      win.webContents.send('island:cursor', { x: point.x - bounds.x, y: point.y - bounds.y })
    }
    const now = point.x >= bounds.x + shape.x && point.x <= bounds.x + shape.x + shape.w &&
      point.y >= bounds.y + shape.y && point.y <= bounds.y + shape.y + shape.h
    if (now === inside) return
    inside = now
    win.setIgnoreMouseEvents(!now, { forward: true })
    win.webContents.send('island:pointer', now)
  }

  function onDisplaysChanged() {
    if (!win || win.isDestroyed()) return
    const display = screen.getPrimaryDisplay()
    const next = screenMetrics(display)
    win.setBounds(frameFor(display))
    if (!metrics || next.bar !== metrics.bar || next.notch !== metrics.notch) load()
  }

  const fromIsland = event => win && !win.isDestroyed() && event.sender === win.webContents
  const handlers = {
    'island:shape': (event, rect) => {
      if (!fromIsland(event) || !rect) return
      const n = v => (Number.isFinite(v) ? Math.max(0, Math.min(Math.max(WIDTH, HEIGHT), v)) : 0)
      shape = { x: n(rect.x), y: n(rect.y), w: n(rect.w), h: n(rect.h) }
      inside = !inside // force track() to re-apply click-through for the new shape
      track()
    },
    'island:focus': event => { if (fromIsland(event)) win.focus() },
    'island:blur': event => { if (fromIsland(event)) win.blur() },
    'island:show-main': (event, view, query) => { if (fromIsland(event)) onShowMain(view === 'failed' ? 'failed' : null, typeof query === 'string' ? query.slice(0, 500) : '') },
  }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.on(channel, handler)
  ipcMain.handle('island:add-files', async (event, paths) => {
    if (!fromIsland(event) || !Array.isArray(paths)) return null
    // Folders are watched, supported files go to the Library, and anything else is reported back by name.
    const existing = paths.filter(p => typeof p === 'string' && fs.existsSync(p))
    // iWork documents saved as folders are documents, not folders to watch.
    const folders = existing.filter(p => fs.statSync(p).isDirectory() && !isPackage(p))
    const files = existing.filter(p => (fs.statSync(p).isFile() || isPackage(p)) && isSupportedFile(p))
    const unsupported = existing.filter(p => !folders.includes(p) && !files.includes(p)).map(p => path.basename(p))
    try {
      const result = files.length ? await onAddFiles(files) : { added: 0, duplicates: 0, failed: 0 }
      if (folders.length) await onWatchFolders(folders)
      return { ...result, unsupported, watched: folders }
    } catch (err) {
      // E.g. adding files or watching folders is switched off in Settings.
      return { added: 0, duplicates: 0, failed: 0, unsupported: [], watched: [], error: err.message }
    }
  })
  screen.on('display-metrics-changed', onDisplaysChanged)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)

  create()

  return {
    setSound(on) {
      sound = on
      if (win && !win.isDestroyed()) win.webContents.send('island:settings', { sound: on })
    },
    /** The quick-search shortcut as shown to people ("⌘⇧Space"), or '' when there is none. */
    setShortcut(label) {
      shortcut = label
      if (win && !win.isDestroyed()) win.webContents.send('island:settings', { shortcut: label })
    },
    /** Opens the quick search (used by the global shortcut). */
    openSearch() {
      if (!win || win.isDestroyed()) return
      win.webContents.send('island:open-search')
      win.focus()
    },
    destroy() {
      clearInterval(timer)
      for (const channel of Object.keys(handlers)) ipcMain.removeAllListeners(channel)
      ipcMain.removeHandler('island:add-files')
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
      screen.removeListener('display-added', onDisplaysChanged)
      screen.removeListener('display-removed', onDisplaysChanged)
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    },
  }
}

module.exports = { createIsland, screenMetrics }
