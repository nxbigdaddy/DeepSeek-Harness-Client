import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { Controller } from './controller'

const __dirname = dirname(fileURLToPath(import.meta.url))

let controller: Controller | undefined

/** Packaged runs have no console; park fatal main-process errors on disk. */
function installCrashLogging(): void {
  const logPath = join(app.getPath('userData'), 'main-crash.log')
  const write = (kind: string, error: unknown): void => {
    try {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
      appendFileSync(logPath, `[${new Date().toISOString()}] ${kind}: ${text}\n`, 'utf8')
    } catch {
      // nowhere left to report
    }
    console.error(`[main] ${kind}:`, error)
  }
  process.on('uncaughtException', (e) => write('uncaughtException', e))
  process.on('unhandledRejection', (e) => write('unhandledRejection', e))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness Client',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Tool output contains untrusted links. A default window.open child would
  // inherit the preload (full window.dsh bridge) — deny every open and push
  // real http(s) links to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The app never navigates after load; block untrusted content taking over.
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function registerIpc(): void {
  ipcMain.handle('dsh:getHostInfo', () => controller?.getHostInfo())
  ipcMain.handle('dsh:listSessions', () => controller?.listSessions())
  ipcMain.handle('dsh:createSession', (_event, opts?: { cwd?: string; workspaceId?: string }) => controller?.createSession(opts))
  ipcMain.handle('dsh:prompt', (_event, sessionId: string, content: unknown) => controller?.prompt(sessionId, content as never))
  ipcMain.handle('dsh:cancel', (_event, sessionId: string) => controller?.cancel(sessionId))
  ipcMain.handle('dsh:history', (_event, sessionId: string, beforeSeq?: number, maxMessages?: number) =>
    controller?.history(sessionId, beforeSeq, maxMessages)
  )
  ipcMain.handle('dsh:searchSessions', (_event, query: string) => controller?.searchSessions(query))
  ipcMain.handle('dsh:forkSession', (_event, sessionId: string) => controller?.forkSession(sessionId))
  ipcMain.handle('dsh:attachment', (_event, sessionId: string, attachmentId: string) => controller?.attachment(sessionId, attachmentId))
  ipcMain.handle('dsh:updateQueue', (_event, sessionId: string, itemId: string, action: unknown) =>
    controller?.updateQueue(sessionId, itemId, action as never)
  )
  ipcMain.handle('dsh:sessionRename', (_event, sessionId: string, title: string) => controller?.sessionRename(sessionId, title))
  ipcMain.handle('dsh:sessionModels', (_event, sessionId: string) => controller?.sessionModels(sessionId))
  ipcMain.handle('dsh:sessionSelectModel', (_event, sessionId: string, provider: string, model: string) =>
    controller?.sessionSelectModel(sessionId, provider, model)
  )
  ipcMain.handle('dsh:archiveSession', (_event, sessionId: string) => controller?.archiveSession(sessionId))
  ipcMain.handle('dsh:respond', (_event, rpcId: string, value: unknown) => controller?.respond(rpcId, value))

  ipcMain.handle('dsh:listWorkspaces', () => controller?.listWorkspaces())
  ipcMain.handle('dsh:createWorkspace', (_event, path: string) => controller?.createWorkspace(path))
  ipcMain.handle('dsh:renameWorkspace', (_event, workspaceId: string, title: string) => controller?.renameWorkspace(workspaceId, title))
  ipcMain.handle('dsh:deleteWorkspace', (_event, workspaceId: string) => controller?.deleteWorkspace(workspaceId))
  ipcMain.handle('dsh:moveSessionBefore', (_event, workspaceId: string, sessionId: string, beforeSessionId?: string) =>
    controller?.moveSessionBefore(workspaceId, sessionId, beforeSessionId)
  )
  ipcMain.handle('dsh:reorderWorkspace', (_event, workspaceId: string, beforeWorkspaceId?: string) =>
    controller?.reorderWorkspace(workspaceId, beforeWorkspaceId)
  )
  ipcMain.handle('dsh:pickDirectory', () => controller?.pickDirectory())
  ipcMain.handle('dsh:listDirectory', (_event, path?: string) => controller?.listDirectory(path))
  ipcMain.handle('dsh:createDirectory', (_event, path: string, name: string) => controller?.createDirectory(path, name))
  ipcMain.handle('dsh:openPath', (_event, path: string) => controller?.openPath(path))

  ipcMain.handle('dsh:settingsDescribe', () => controller?.settingsDescribe())
  ipcMain.handle('dsh:settingsMutate', (_event, ns: string, ops: unknown, expectedRevision?: number) =>
    controller?.settingsMutate(ns, ops as never, expectedRevision)
  )
  ipcMain.handle('dsh:settingsReplace', (_event, ns: string, section: object, expectedRevision?: number) =>
    controller?.settingsReplace(ns, section, expectedRevision)
  )
  ipcMain.handle('dsh:settingsOpenDocument', () => controller?.settingsOpenDocument())
  ipcMain.handle('dsh:llmModels', () => controller?.llmModels())

  ipcMain.handle('dsh:goalCreate', (_e, sessionId: string, objective: string, maxGoalRounds?: number) => controller?.goalCreate(sessionId, objective, maxGoalRounds))
  ipcMain.handle('dsh:goalEdit', (_e, sessionId: string, ref: { id: string; revision: number }, objective?: string, maxGoalRounds?: number) => controller?.goalEdit(sessionId, ref, objective, maxGoalRounds))
  ipcMain.handle('dsh:goalPause', (_e, sessionId: string, ref: { id: string; revision: number }) => controller?.goalPause(sessionId, ref))
  ipcMain.handle('dsh:goalResume', (_e, sessionId: string, ref: { id: string; revision: number }) => controller?.goalResume(sessionId, ref))
  ipcMain.handle('dsh:goalComplete', (_e, sessionId: string, ref: { id: string; revision: number }) => controller?.goalComplete(sessionId, ref))
  ipcMain.handle('dsh:goalClear', (_e, sessionId: string, ref: { id: string; revision: number }) => controller?.goalClear(sessionId, ref))
  ipcMain.handle('dsh:subagentList', (_e, parentSessionId: string) => controller?.subagentList(parentSessionId))
  ipcMain.handle('dsh:subagentHistory', (_e, parentSessionId: string, childSessionId: string, mode: string) => controller?.subagentHistory(parentSessionId, childSessionId, mode))
  ipcMain.handle('dsh:subagentPrompt', (_e, parentSessionId: string, childSessionId: string, text: string) => controller?.subagentPrompt(parentSessionId, childSessionId, text))
  ipcMain.handle('dsh:subagentInterrupt', (_e, parentSessionId: string, childSessionId: string) => controller?.subagentInterrupt(parentSessionId, childSessionId))
  ipcMain.handle('dsh:skillsList', (_e, sessionId: string) => controller?.skillsList(sessionId))
  ipcMain.handle('dsh:agentPresetList', () => controller?.agentPresetList())
  ipcMain.handle('dsh:agentPresetSelect', (_e, sessionId: string, agentPreset: string) => controller?.agentPresetSelect(sessionId, agentPreset))
  ipcMain.handle('dsh:credentialsDescribe', (_e, refs: string[]) => controller?.credentialsDescribe(refs))
  ipcMain.handle('dsh:credentialsSet', (_e, ref: string, value: string) => controller?.credentialsSet(ref, value))
  ipcMain.handle('dsh:credentialsUnset', (_e, ref: string) => controller?.credentialsUnset(ref))
  ipcMain.handle('dsh:getConnectionConfig', () => controller?.getConnectionConfig())
  ipcMain.handle('dsh:setConnectionConfig', (_e, cfg: { mode: 'embedded' | 'remote'; remoteUrl?: string }) => controller?.setConnectionConfig(cfg))
  ipcMain.handle('dsh:retryConnect', () => controller?.retryConnect())
}

// Two instances would share one DSH_HOME (workspace registry contention) and
// race for ports; keep exactly one, focusing the running window on relaunch.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    installCrashLogging()
    registerIpc()
    const win = createWindow()
    controller = new Controller()
    void controller
      .start(win)
      .catch((error) => {
        console.error('[main] failed to start controller:', error)
        win.webContents.send('dsh:hostInfo', {
          baseUrl: '',
          port: 0,
          state: 'reconnecting',
          error: String(error?.message ?? error)
        })
      })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const win = createWindow()
        controller?.attachWindow(win)
      }
    })
  })
}

app.on('window-all-closed', () => {
  // On macOS the app keeps running without windows; stopping the controller
  // here would kill the host and leave a recreated window dead. will-quit
  // is the single teardown point.
  if (process.platform !== 'darwin') {
    controller?.stop()
    app.quit()
  }
})

app.on('will-quit', () => {
  controller?.stop()
})
