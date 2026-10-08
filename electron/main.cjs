const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, Notification, ipcMain, globalShortcut, safeStorage, session } = require('electron')
const { createIsland } = require('./island.cjs')
const path = require('path')
const fs = require('fs')

let mainWindow = null
let tray = null
let duct = null
let server = null
let serverUrl = ''
let library = null
let formats = null   // src/formats.ts: the supported file types
let island = null
let account = null     // src/account.ts: Sign in with Tensflare
let telemetry = null   // src/telemetry.ts: anonymous usage counts
let ledger = null      // src/ledger.ts: what left this computer

const SEARCH_SHORTCUT = 'CommandOrControl+Shift+Space'

// Desktop-only preferences (the index's own settings live in its database).
function prefsPath() { return path.join(app.getPath('userData'), 'desktop-settings.json') }
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf-8')) } catch { return {} }
}
function writePrefs(prefs) {
  try { fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2)) } catch (err) { console.error('Could not save preferences:', err) }
}
// API keys entered in Settings are encrypted with the OS keychain (safeStorage) and restored at launch.
function secretsPath() { return path.join(app.getPath('userData'), 'secrets.bin') }
function readSecrets() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(secretsPath())) return {}
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(secretsPath())))
  } catch (err) {
    console.error('Could not read saved API keys:', err.message)
    return {}
  }
}
function saveSecrets(keys) {
  if (!safeStorage.isEncryptionAvailable()) return   // without a keychain, keys stay in memory for this session only
  const merged = { ...readSecrets(), ...keys }
  fs.writeFileSync(secretsPath(), safeStorage.encryptString(JSON.stringify(merged)), { mode: 0o600 })
}

// The island is on by default on macOS, where it lives in the notch or menu bar; elsewhere it is opt-in.
function islandEnabled() {
  const prefs = readPrefs()
  return typeof prefs.island === 'boolean' ? prefs.island : process.platform === 'darwin'
}

function soundsEnabled() {
  return readPrefs().sounds !== false
}

function setSoundsEnabled(on) {
  writePrefs({ ...readPrefs(), sounds: on })
  island?.setSound(on)
  createAppMenu()
  updateTrayMenu()
}

function shortcutEnabled() {
  return readPrefs().shortcut !== false
}

function setShortcutEnabled(on) {
  writePrefs({ ...readPrefs(), shortcut: on })
  if (on) registerShortcut()
  else globalShortcut.unregister(SEARCH_SHORTCUT)
}

function registerShortcut() {
  if (shortcutEnabled()) registerShortcut()
}

// Desktop-only switches shown in the page's Settings > Features (the rest live in the index's settings).
const DESKTOP_PREFS = {
  island: { get: islandEnabled, set: on => setIslandEnabled(on) },
  sounds: { get: soundsEnabled, set: on => setSoundsEnabled(on) },
  shortcut: { get: shortcutEnabled, set: on => setShortcutEnabled(on) },
}

function startIsland() {
  if (island || !serverUrl) return
  const prefs = readPrefs()
  // The hello sound plays once, on the first launch with the island.
  if (!prefs.greeted) writePrefs({ ...prefs, greeted: true })
  island = createIsland({
    serverUrl,
    sound: soundsEnabled(),
    hello: !prefs.greeted,
    onShowMain: view => {
      mainWindow?.show()
      mainWindow?.focus()
      if (view === 'failed') callPage('showFailed')
    },
    isSupportedFile: p => formats.isSupportedFile(p),
    isPackage: p => formats.PACKAGE_EXTENSIONS.has(path.extname(p).toLowerCase()),
    onWatchFolders: async folders => {
      await duct.watch(folders, refreshPage)
      refreshPage()
    },
    onAddFiles: async files => {
      const result = await addFilesToLibrary(files)
      notify(`Added ${result.added} file(s) to your Duct Library` + (result.duplicates ? `, skipped ${result.duplicates} already indexed` : ''))
      return result
    },
  })
}

function setIslandEnabled(on) {
  writePrefs({ ...readPrefs(), island: on })
  if (on) startIsland()
  else if (island) { island.destroy(); island = null }
  createAppMenu()
  updateTrayMenu()
}

// The global shortcut opens the island's quick search, or the main window when the island is off.
function openQuickSearch() {
  if (island) { island.openSearch(); return }
  mainWindow?.show()
  mainWindow?.focus()
  callPage('focusSearch')
}

// One running copy only: a second launch focuses the existing window instead of opening the same index twice.
// Overrides for tests and portable installs.
if (process.env.DUCT_USER_DATA_DIR) app.setPath('userData', process.env.DUCT_USER_DATA_DIR)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function libraryDir() {
  return process.env.DUCT_LIBRARY_DIR || path.join(app.getPath('home'), 'Duct Library')
}

async function createDuct() {
  // First, so every connection Duct makes from here on is in the privacy ledger (Settings › Privacy).
  ledger = (await import('../dist/ledger.js')).installLedger(app.getPath('userData'))
  // The windows' own connections (Chromium, e.g. spell-check dictionaries) go in the ledger too.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try { ledger.record(details.url, details.method, 0) } catch {}
    callback({})
  })
  const { Duct } = await import('../dist/index.js')
  library = await import('../dist/library.js')
  formats = await import('../dist/formats.js')
  duct = new Duct({
    persistPath: path.join(app.getPath('userData'), 'data'),
    search: { rerank: true },
  })
  const keys = readSecrets()
  if (Object.keys(keys).length) duct.configure(keys)   // configure() never writes keys to disk
  return duct
}

// The account's tokens are encrypted with the OS keychain, like API keys. Without a keychain they last for this session.
function accountStorage() {
  const file = path.join(app.getPath('userData'), 'account.bin')
  let memory = null
  return {
    load() {
      if (!safeStorage.isEncryptionAvailable()) return memory
      try { return fs.existsSync(file) ? JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) : null } catch { return null }
    },
    save(state) {
      memory = state
      if (!safeStorage.isEncryptionAvailable()) return
      if (!state) { fs.rmSync(file, { force: true }); return }
      fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 })
    },
  }
}

// Crash records (src/diagnostics.ts): error type and Duct's own stack frames only, kept on this device until
// the person chooses to send them with feedback.
function crashDir() { return path.join(app.getPath('userData'), 'crashes') }
let diagnostics = null
async function installCrashRecording() {
  diagnostics = await import('../dist/diagnostics.js')
  diagnostics.installCrashHandlers(crashDir(), 'main')
  app.on('render-process-gone', (_e, _wc, details) => diagnostics.recordCrash(crashDir(), 'page', details.reason))
  app.on('child-process-gone', (_e, details) => { if (details.reason !== 'clean-exit') diagnostics.recordCrash(crashDir(), details.type, details.reason) })
}

async function startServer() {
  const { createServer } = await import('../dist/server.js')
  const { TensflareAccount } = await import('../dist/account.js')
  const { Telemetry } = await import('../dist/telemetry.js')
  account = new TensflareAccount({ storage: accountStorage(), openUrl: url => shell.openExternal(url) })
  account.refresh().catch(() => {})
  setInterval(() => { account.refresh().catch(() => {}) }, 60 * 60 * 1000).unref()
  ;(await import('../dist/hosted.js')).setHostedAi(account.hostedAi())
  const { SettingsSync } = await import('../dist/sync.js')
  const sync = new SettingsSync(duct, account, app.getPath('userData'))
  sync.start()
  // Cloud sources (Team): tokens encrypted with the OS keychain, like the account's.
  const { ConnectorManager } = await import('../dist/connectors/manager.js')
  const { clientIdsFromEnv } = await import('../dist/connectors/sources.js')
  const vaultFile = path.join(app.getPath('userData'), 'connectors.bin')
  let vaultMemory = {}
  const connectors = new ConnectorManager(duct, {
    dir: path.join(app.getPath('userData'), 'connectors'),
    vault: {
      load() {
        if (!safeStorage.isEncryptionAvailable()) return vaultMemory
        try { return fs.existsSync(vaultFile) ? JSON.parse(safeStorage.decryptString(fs.readFileSync(vaultFile))) : {} } catch { return {} }
      },
      save(all) {
        vaultMemory = all
        if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(vaultFile, safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 })
      },
    },
    clientIds: clientIdsFromEnv(process.env),
    openUrl: url => shell.openExternal(url),
    entitled: () => account.has('team.connectors'),
    onChange: () => refreshPage(),
  })
  connectors.start()
  telemetry = new Telemetry({
    dir: app.getPath('userData'), channel: 'desktop', duct,
    plan: () => account.status().plan,
    prefs: () => ({ island: islandEnabled(), sounds: soundsEnabled() }),
  })
  telemetry.start()
  const expressApp = createServer(duct, { uploadLimitMb: 100, libraryDir: libraryDir(), onSecrets: saveSecrets, account, telemetry, crashDir: crashDir(), channel: 'desktop', sync, connectors })
  return new Promise((resolve) => {
    server = expressApp.listen(0, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${server.address().port}`
      resolve(serverUrl)
    })
  })
}

/** Calls one of the page's window.duct functions (assets/ui/app.js). */
function callPage(name) {
  if (!['refresh', 'showFailed', 'focusSearch', 'openSettings', 'exportResults', 'openFeedback', 'copyDiagnostics'].includes(name)) return
  mainWindow?.webContents.executeJavaScript(`window.duct && window.duct.${name}()`).catch(() => {})
}

// Asks the page to refresh its counts, document list and mascot after background changes.
function refreshPage() {
  callPage('refresh')
}

function notify(body) {
  new Notification({ title: 'Duct', body }).show()
}

// Copies files into ~/Duct Library and indexes the copies (duplicates are skipped).
async function addFilesToLibrary(filePaths) {
  let added = 0
  let duplicates = 0
  let failed = 0
  for (const file of filePaths) {
    const r = await library.addToLibrary(duct, libraryDir(), file)
    if (r.duplicateOf) duplicates++
    else added += r.documents
    failed += r.failed ?? 0
  }
  refreshPage()
  return { added, duplicates, failed }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Duct',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    backgroundColor: '#0C0C0B',
  })

  // Links opened from the page (e.g. indexed web pages) go to the system browser, never a bare Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(serverUrl)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) event.preventDefault()
  })

  mainWindow.loadURL(serverUrl)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('close', (e) => {
    if (app.getLoginItemSettings().wasOpenedAtLogin) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

function createAppMenu() {
  const template = [
    {
      label: 'Duct',
      submenu: [
        {
          label: 'About Duct',
          role: 'about',
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => callPage('openSettings'),
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Files to Library…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: formats.dialogFilters(),
            })
            if (result.canceled || result.filePaths.length === 0) return
            try {
              const { added, duplicates } = await addFilesToLibrary(result.filePaths)
              notify(`Added ${added} file(s) to your Duct Library` + (duplicates ? `, skipped ${duplicates} already indexed` : ''))
            } catch (err) {
              dialog.showErrorBox('Could not add files', err.message)
            }
          },
        },
        {
          label: 'Watch Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
            if (result.canceled || result.filePaths.length === 0) return
            try {
              await duct.watch([result.filePaths[0]], refreshPage)
              refreshPage()
              notify(`Watching ${result.filePaths[0]}`)
            } catch (err) {
              dialog.showErrorBox('Could not watch folder', err.message)
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Export Search Results…',
          accelerator: 'Cmd+E',
          click: () => callPage('exportResults'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: process.platform === 'darwin' ? 'Show Duct in the Menu Bar Notch' : 'Show Duct at the Top of the Screen', type: 'checkbox', checked: islandEnabled(), click: item => setIslandEnabled(item.checked) },
        { label: 'Quick Search', accelerator: SEARCH_SHORTCUT, registerAccelerator: false, click: openQuickSearch },
        { label: 'Play Sounds', type: 'checkbox', checked: soundsEnabled(), click: item => setSoundsEnabled(item.checked) },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'Cmd+R', role: 'reload' },
        { label: 'Toggle DevTools', accelerator: 'Cmd+Alt+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'Cmd+=', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'Cmd+-', role: 'zoomOut' },
        { label: 'Reset Zoom', accelerator: 'Cmd+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'Cmd+Ctrl+F', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'Cmd+M', role: 'minimize' },
        { label: 'Close', accelerator: 'Cmd+W', role: 'close' },
        { type: 'separator' },
        { label: 'Bring All to Front', role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Send Feedback…', click: () => { mainWindow?.show(); callPage('openFeedback') } },
        { label: 'Copy Diagnostics', click: () => callPage('copyDiagnostics') },
        { type: 'separator' },
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/docfide/duct/tree/main/docs') },
        { label: 'What Duct Sends', click: () => shell.openExternal('https://duct.tensflare.com/privacy/usage-counts/') },
        { label: 'Privacy Policy', click: () => shell.openExternal('https://duct.tensflare.com/legal/privacy/') },
        { label: 'Terms of Service', click: () => shell.openExternal('https://duct.tensflare.com/legal/terms/') },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function trayImage(resting) {
  // Template images (macOS) are recoloured for light/dark menu bars; Electron loads the @2x file automatically.
  const name = process.platform === 'darwin'
    ? (resting ? 'trayRestingTemplate.png' : 'trayTemplate.png')
    : (resting ? 'trayResting.png' : 'tray.png')
  const iconPath = path.join(__dirname, 'icons', name)
  return fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
}

let trayResting = null
let trayTooltip = ''

// The mascot dozes in the tray while folders are watched and wakes up while it is indexing.
function updateTray() {
  if (!tray || !duct) return
  const watched = duct.listSources().length
  const activity = duct.activity()
  const resting = watched > 0 && !activity.indexing
  if (resting !== trayResting) {
    tray.setImage(trayImage(resting))
    trayResting = resting
  }
  const tooltip = activity.indexing
    ? `Duct: indexing ${activity.done} of ${activity.total}`
    : watched > 0 ? `Duct: watching ${watched} folder${watched === 1 ? '' : 's'}` : 'Duct'
  if (tooltip !== trayTooltip) {
    tray.setToolTip(tooltip)
    trayTooltip = tooltip
  }
}

function updateTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Duct', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: 'Quick Search', click: openQuickSearch },
    { label: process.platform === 'darwin' ? 'Show in the Notch' : 'Show at the Top of the Screen', type: 'checkbox', checked: islandEnabled(), click: item => setIslandEnabled(item.checked) },
    { label: 'Play Sounds', type: 'checkbox', checked: soundsEnabled(), click: item => setSoundsEnabled(item.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))
}

function createTray() {
  try {
    tray = new Tray(trayImage(false))
    tray.setToolTip('Duct')
    updateTrayMenu()
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
    updateTray()
    setInterval(updateTray, 2000).unref()
  } catch {}
}

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: formats.dialogFilters(),
  })
  return result.canceled ? null : result.filePaths
})

// The page asks to watch a folder; the user picks it here, so the HTTP API never accepts arbitrary paths.
ipcMain.handle('duct:watchDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const dir = result.filePaths[0]
  // Return straight away so the page can show progress; indexing the folder continues in the background.
  duct.watch([dir], refreshPage).then(refreshPage).catch(err => notify(`Could not watch ${dir}: ${err.message}`))
  return dir
})

// Only documents in the index can be opened or revealed; the page can't name arbitrary paths.
// PDFs open in Duct's viewer at the page, with the matched words highlighted; other files use their default app.
async function openDocument(filePath, page, terms) {
  const doc = indexedFile(filePath)
  if (!doc) return false
  if (path.extname(doc.path).toLowerCase() === '.pdf') {
    const safeTerms = Array.isArray(terms) ? terms.filter(t => typeof t === 'string').slice(0, 12) : []
    const pageNumber = Number.isInteger(page) && page > 0 ? page : 1
    const viewer = new BrowserWindow({
      width: 1000,
      height: 1100,
      title: doc.displayName || path.basename(doc.path),
      backgroundColor: '#0C0C0B',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    viewer.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(serverUrl)) event.preventDefault() })
    viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await viewer.loadURL(`${serverUrl}/viewer?path=${encodeURIComponent(doc.path)}&page=${pageNumber}&terms=${encodeURIComponent(JSON.stringify(safeTerms))}`)
    return true
  }
  telemetry?.record('opens')
  return (await shell.openPath(doc.path)) === ''
}

function indexedFile(filePath) {
  const doc = typeof filePath === 'string' ? duct.getDocument(filePath) : undefined
  if (!doc || doc.source === 'url' || !fs.existsSync(doc.path)) return null
  return doc
}

ipcMain.handle('duct:openDocument', (_event, filePath, page, terms) => openDocument(filePath, page, terms))

ipcMain.handle('duct:revealDocument', (_event, filePath) => {
  const doc = indexedFile(filePath)
  if (!doc) return false
  shell.showItemInFolder(doc.path)
  return true
})

ipcMain.handle('notification:show', (_event, title, body) => {
  new Notification({ title, body }).show()
})

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('prefs:get', () => Object.fromEntries(Object.entries(DESKTOP_PREFS).map(([k, p]) => [k, p.get()])))
ipcMain.handle('prefs:set', (_event, name, on) => {
  const pref = DESKTOP_PREFS[name]
  if (!pref || typeof on !== 'boolean') return false
  pref.set(on)
  return true
})

app.whenReady().then(async () => {
  if (!gotLock) return
  await installCrashRecording()
  await createDuct()
  const url = await startServer()
  console.log(`  Server started at ${url}`)

  createAppMenu()
  createWindow()
  createTray()
  if (islandEnabled()) startIsland()
  if (!globalShortcut.register(SEARCH_SHORTCUT, openQuickSearch)) console.error(`Could not register ${SEARCH_SHORTCUT}; it may be used by another app.`)

  // Catch up on watched folders (files added, changed or deleted while Duct was closed), then keep watching.
  duct.restoreSources(refreshPage).then(refreshPage).catch(err => console.error('Could not restore watched folders:', err))
  // Safety net for missed file events (network drives, sleep/wake): recheck watched folders every 30 minutes.
  setInterval(() => {
    duct?.rescanSources().then(refreshPage).catch(err => console.error('Rescan failed:', err))
  }, 30 * 60 * 1000).unref()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
  else mainWindow.show()
})

// The index is kept between launches; quitting only stops watchers and closes the database.
app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  if (island) { island.destroy(); island = null }
  if (tray) tray.destroy()
  if (server) server.close()
  if (telemetry) telemetry.stop()   // saves today's counters
  if (ledger) ledger.save()
  if (duct) {
    try { duct.close() } catch {}
    duct = null
  }
})
