const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveDb: db => ipcRenderer.invoke('db:save', db),
  libDir: () => ipcRenderer.invoke('lib:dir'),
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  importItems: (paths, asSequence) => ipcRenderer.invoke('items:import', paths, asSequence),
  deleteItem: id => ipcRenderer.invoke('items:delete', id),
  itemMenu: (id, file, labels) => ipcRenderer.invoke('items:menu', id, file, labels),
  toJpg: id => ipcRenderer.invoke('items:toJpg', id),
  editorOpen: src => ipcRenderer.invoke('editor:open', src),
  exportVideo: opts => ipcRenderer.invoke('editor:exportVideo', opts),
  dedupFrames: opts => ipcRenderer.invoke('editor:dedupFrames', opts),
  writeItemFile: (id, name, data) => ipcRenderer.invoke('items:writeFile', id, name, data),
  exportFrames: opts => ipcRenderer.invoke('editor:exportFrames', opts),
  pathForFile: file => webUtils.getPathForFile(file),
})
