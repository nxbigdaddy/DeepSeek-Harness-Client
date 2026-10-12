import { contextBridge, ipcRenderer } from 'electron'
import type { DsApi, DownlinkFrame, HostInfo, SettingsPathOp } from '../shared/ipc'

const api: DsApi = {
  getHostInfo: () => ipcRenderer.invoke('dsh:getHostInfo'),
  listSessions: () => ipcRenderer.invoke('dsh:listSessions'),
  createSession: (opts) => ipcRenderer.invoke('dsh:createSession', opts),
  prompt: (sessionId, content) => ipcRenderer.invoke('dsh:prompt', sessionId, content),
  cancel: (sessionId) => ipcRenderer.invoke('dsh:cancel', sessionId),
  history: (sessionId, beforeSeq, maxMessages) =>
    ipcRenderer.invoke('dsh:history', sessionId, beforeSeq, maxMessages),
  searchSessions: (query) => ipcRenderer.invoke('dsh:searchSessions', query),
  forkSession: (sessionId) => ipcRenderer.invoke('dsh:forkSession', sessionId),
  attachment: (sessionId, attachmentId) => ipcRenderer.invoke('dsh:attachment', sessionId, attachmentId),
  updateQueue: (sessionId, itemId, action) => ipcRenderer.invoke('dsh:updateQueue', sessionId, itemId, action),
  sessionRename: (sessionId, title) => ipcRenderer.invoke('dsh:sessionRename', sessionId, title),
  sessionModels: (sessionId) => ipcRenderer.invoke('dsh:sessionModels', sessionId),
  sessionSelectModel: (sessionId, provider, model) =>
    ipcRenderer.invoke('dsh:sessionSelectModel', sessionId, provider, model),
  archiveSession: (sessionId) => ipcRenderer.invoke('dsh:archiveSession', sessionId),
  respond: (rpcId, value) => ipcRenderer.invoke('dsh:respond', rpcId, value),

  listWorkspaces: () => ipcRenderer.invoke('dsh:listWorkspaces'),
  createWorkspace: (path) => ipcRenderer.invoke('dsh:createWorkspace', path),
  renameWorkspace: (workspaceId, title) => ipcRenderer.invoke('dsh:renameWorkspace', workspaceId, title),
  deleteWorkspace: (workspaceId) => ipcRenderer.invoke('dsh:deleteWorkspace', workspaceId),
  moveSessionBefore: (workspaceId, sessionId, beforeSessionId) =>
    ipcRenderer.invoke('dsh:moveSessionBefore', workspaceId, sessionId, beforeSessionId),
  reorderWorkspace: (workspaceId, beforeWorkspaceId) =>
    ipcRenderer.invoke('dsh:reorderWorkspace', workspaceId, beforeWorkspaceId),
  pickDirectory: () => ipcRenderer.invoke('dsh:pickDirectory'),
  listDirectory: (path) => ipcRenderer.invoke('dsh:listDirectory', path),
  createDirectory: (path, name) => ipcRenderer.invoke('dsh:createDirectory', path, name),
  openPath: (path) => ipcRenderer.invoke('dsh:openPath', path),

  settingsDescribe: () => ipcRenderer.invoke('dsh:settingsDescribe'),
  settingsMutate: (ns, ops, expectedRevision) =>
    ipcRenderer.invoke('dsh:settingsMutate', ns, ops as SettingsPathOp[], expectedRevision),
  settingsReplace: (ns, section, expectedRevision) =>
    ipcRenderer.invoke('dsh:settingsReplace', ns, section, expectedRevision),
  settingsOpenDocument: () => ipcRenderer.invoke('dsh:settingsOpenDocument'),
  llmModels: () => ipcRenderer.invoke('dsh:llmModels'),

  goalCreate: (sessionId, objective, maxGoalRounds) => ipcRenderer.invoke('dsh:goalCreate', sessionId, objective, maxGoalRounds),
  goalEdit: (sessionId, ref, objective, maxGoalRounds) => ipcRenderer.invoke('dsh:goalEdit', sessionId, ref, objective, maxGoalRounds),
  goalPause: (sessionId, ref) => ipcRenderer.invoke('dsh:goalPause', sessionId, ref),
  goalResume: (sessionId, ref) => ipcRenderer.invoke('dsh:goalResume', sessionId, ref),
  goalComplete: (sessionId, ref) => ipcRenderer.invoke('dsh:goalComplete', sessionId, ref),
  goalClear: (sessionId, ref) => ipcRenderer.invoke('dsh:goalClear', sessionId, ref),
  subagentList: (parentSessionId) => ipcRenderer.invoke('dsh:subagentList', parentSessionId),
  subagentHistory: (parentSessionId, childSessionId, mode) => ipcRenderer.invoke('dsh:subagentHistory', parentSessionId, childSessionId, mode),
  subagentPrompt: (parentSessionId, childSessionId, text) => ipcRenderer.invoke('dsh:subagentPrompt', parentSessionId, childSessionId, text),
  subagentInterrupt: (parentSessionId, childSessionId) => ipcRenderer.invoke('dsh:subagentInterrupt', parentSessionId, childSessionId),
  skillsList: (sessionId) => ipcRenderer.invoke('dsh:skillsList', sessionId),
  agentPresetList: () => ipcRenderer.invoke('dsh:agentPresetList'),
  agentPresetSelect: (sessionId, agentPreset) => ipcRenderer.invoke('dsh:agentPresetSelect', sessionId, agentPreset),
  credentialsDescribe: (refs) => ipcRenderer.invoke('dsh:credentialsDescribe', refs),
  credentialsSet: (ref, value) => ipcRenderer.invoke('dsh:credentialsSet', ref, value),
  credentialsUnset: (ref) => ipcRenderer.invoke('dsh:credentialsUnset', ref),
  getConnectionConfig: () => ipcRenderer.invoke('dsh:getConnectionConfig'),
  setConnectionConfig: (cfg) => ipcRenderer.invoke('dsh:setConnectionConfig', cfg),
  retryConnect: () => ipcRenderer.invoke('dsh:retryConnect'),

  onFrame: (cb) => {
    const listener = (_event: unknown, frame: DownlinkFrame): void => cb(frame)
    ipcRenderer.on('dsh:frame', listener)
    return () => {
      ipcRenderer.removeListener('dsh:frame', listener)
    }
  },
  onHostInfo: (cb) => {
    const listener = (_event: unknown, info: HostInfo): void => cb(info)
    ipcRenderer.on('dsh:hostInfo', listener)
    return () => {
      ipcRenderer.removeListener('dsh:hostInfo', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dsh', api)
