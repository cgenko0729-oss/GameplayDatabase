const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')
const os = require('os')
// 打包后 ffmpeg 在 app.asar.unpacked 里才能执行
const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')

// 开发时用专案里的 library；打包成 portable exe 后用 exe 旁边的 library
const BASE_DIR = app.isPackaged
  ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
  : path.join(__dirname, '..')
const LIB_DIR = path.join(BASE_DIR, 'library')
const ITEMS_DIR = path.join(LIB_DIR, 'items')
const DB_FILE = path.join(LIB_DIR, 'library.json')

const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.m4v']
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

fs.mkdirSync(ITEMS_DIR, { recursive: true })

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { items: [] }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  // 旧项目补上档案大小
  for (const it of db.items) if (it.size == null) it.size = dirSize(it.id, it.files)
  return db
}

function dirSize(id, files) {
  return files.reduce((sum, f) => {
    try { return sum + fs.statSync(path.join(ITEMS_DIR, id, f)).size } catch { return sum }
  }, 0)
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// 把档案复制进 items/<id>/，回传新项目；names 可指定档名
function createItem(type, srcPaths, names) {
  const id = newId()
  const dir = path.join(ITEMS_DIR, id)
  fs.mkdirSync(dir)
  const files = srcPaths.map((src, i) => {
    const ext = path.extname(src).toLowerCase()
    const name = names ? names[i] : type === 'sequence' ? String(i + 1).padStart(4, '0') + ext : 'source' + ext
    fs.copyFileSync(src, path.join(dir, name))
    return name
  })
  return {
    id,
    type,
    files,
    title: path.basename(srcPaths[0], path.extname(srcPaths[0])),
    description: '',
    tags: [],
    createdAt: Date.now(),
    size: dirSize(id, files),
  }
}

function kindOf(p) {
  const ext = path.extname(p).toLowerCase()
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (IMAGE_EXT.includes(ext)) return 'image'
  return null
}

ipcMain.handle('db:load', () => loadDb())
ipcMain.handle('db:save', (_e, db) => saveDb(db))
ipcMain.handle('lib:dir', () => pathToFileURL(ITEMS_DIR).href)

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: [...VIDEO_EXT, ...IMAGE_EXT].map(e => e.slice(1)) }],
  })
  return r.canceled ? [] : r.filePaths
})

// paths: 档案路径；asSequence: 多张图片合成一个序列帧
ipcMain.handle('items:import', (_e, paths, asSequence) => {
  const valid = paths.filter(kindOf)
  // 序列帧按档名自然排序
  if (asSequence) {
    const imgs = valid.filter(p => kindOf(p) === 'image')
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return imgs.length ? [createItem('sequence', imgs)] : []
  }
  return valid.map(p => createItem(kindOf(p), [p]))
})

// 格子右键选单；labels.toJpg 有值才显示「转成 JPEG」。回传选到的动作（'toJpg' 或 null）
ipcMain.handle('items:menu', (_e, id, file, labels) => new Promise(resolve => {
  let action = null
  Menu.buildFromTemplate([
    { label: labels.openFolder, click: () => shell.showItemInFolder(path.join(ITEMS_DIR, id, file)) },
    ...(labels.toJpg ? [{ label: labels.toJpg, click: () => (action = 'toJpg') }] : []),
  ]).popup({ callback: () => setImmediate(() => resolve(action)) })
}))

// ---------- 序列帧 PNG -> JPEG ----------

// 执行 ffmpeg，回传 stdout（Buffer）
function ffmpegOut(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args])
    const chunks = []
    p.stdout.on('data', d => chunks.push(d))
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg failed: ' + args[1]))))
  })
}

// PNG 是否真的有透明像素（只有带 alpha 的格式才进一步逐像素检查）
async function hasAlpha(file) {
  const log = await ffmpeg(['-i', file], true)
  if (!/Video: png, (rgba|ya|pal8)/.test(log)) return false
  const buf = await ffmpegOut(['-i', file, '-vf', 'format=rgba,alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  return buf.some(b => b < 255)
}

// 同时最多跑 n 个
async function pool(list, n, fn) {
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < list.length) await fn(list[next++])
  }))
}

// 回传 { files, size }；有透明背景回传 { skipped: 'alpha' }；没有 PNG 回传 null
ipcMain.handle('items:toJpg', async (_e, id) => {
  const db = loadDb()
  const item = db.items.find(i => i.id === id)
  const dir = path.join(ITEMS_DIR, id)
  const pngs = item ? item.files.filter(f => /\.png$/i.test(f)) : []
  if (!pngs.length) return null
  // 抽查第一、中间、最后一张
  const samples = [...new Set([pngs[0], pngs[pngs.length >> 1], pngs[pngs.length - 1]])]
  for (const f of samples) if (await hasAlpha(path.join(dir, f))) return { skipped: 'alpha' }

  // 新档名：xxx.png -> xxx.jpg（撞名就加 _1、_2）
  const taken = new Set(item.files.map(f => f.toLowerCase()))
  const rename = new Map()
  for (const f of pngs) {
    let name = f.replace(/\.png$/i, '.jpg')
    for (let k = 1; taken.has(name.toLowerCase()); k++) name = f.replace(/\.png$/i, `_${k}.jpg`)
    taken.add(name.toLowerCase())
    rename.set(f, name)
  }
  await pool(pngs, Math.max(2, os.cpus().length - 1), f =>
    ffmpeg(['-i', path.join(dir, f), '-q:v', '2', path.join(dir, rename.get(f))]))

  // 全部转好才删 PNG
  for (const f of pngs) fs.rmSync(path.join(dir, f), { force: true })
  const tl = path.join(dir, 'timeline.txt')
  if (fs.existsSync(tl)) {
    let text = fs.readFileSync(tl, 'utf8')
    for (const [a, b] of rename) text = text.split(a).join(b)
    fs.writeFileSync(tl, text)
  }
  item.files = item.files.map(f => rename.get(f) || f)
  item.size = dirSize(id, item.files)
  saveDb(db) // 立刻存档，避免中途关掉 app 时资料库还指向已删除的 PNG
  return { files: item.files, size: item.size }
})

ipcMain.handle('items:delete', (_e, id) => {
  fs.rmSync(path.join(ITEMS_DIR, id), { recursive: true, force: true })
})

// 在项目资料夹写入附加档（timeline.txt / overview.jpg）；data 是文字或 dataURL
ipcMain.handle('items:writeFile', (_e, id, name, data) => {
  const buf = data.startsWith('data:') ? Buffer.from(data.split(',')[1], 'base64') : data
  fs.writeFileSync(path.join(ITEMS_DIR, id, name), buf)
})

// ---------- 剪辑器 ----------

// 执行 ffmpeg，回传 stderr；allowFail 用于 `ffmpeg -i` 这种只为读资讯的呼叫
function ffmpeg(args, allowFail = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-y', ...args])
    let log = ''
    p.stderr.on('data', d => (log += d))
    p.on('close', code => (code === 0 || allowFail ? resolve(log) : reject(new Error(log.slice(-1500)))))
  })
}

async function probe(src) {
  const log = await ffmpeg(['-i', src], true)
  const fps = parseFloat((log.match(/([\d.]+) fps/) || log.match(/([\d.]+) tbr/) || [])[1]) || 60
  const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/)
  const duration = d ? d[1] * 3600 + d[2] * 60 + +d[3] : 0
  return { path: src, url: pathToFileURL(src).href, fps, duration, hasAudio: /Stream #.*Audio:/.test(log) }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jgui-'))
const baseName = p => path.basename(p, path.extname(p))
// 帧号 -> ffmpeg -ss 秒数；往前退半帧，确保精准 seek 时第 n 帧不会被丢掉
const frameTime = (n, fps) => Math.max(0, (n - 0.5) / fps).toFixed(6)

ipcMain.handle('editor:open', async (_e, src) => {
  if (!src) {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: VIDEO_EXT.map(e => e.slice(1)) }],
    })
    if (r.canceled) return null
    src = r.filePaths[0]
  }
  return kindOf(src) === 'video' ? probe(src) : null
})

// segments: [{ in, out }] 帧号（含头尾）；toFile: true = 另存为，false = 存进资料库
ipcMain.handle('editor:exportVideo', async (_e, { src, segments, fps, hasAudio, toFile }) => {
  let dest
  if (toFile) {
    const r = await dialog.showSaveDialog({
      defaultPath: path.join(path.dirname(src), baseName(src) + '_cut.mp4'),
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    })
    if (r.canceled) return null
    dest = r.filePath
  }
  const tmp = tmpDir()
  try {
    const parts = []
    for (const [i, s] of segments.entries()) {
      const out = path.join(tmp, `seg${i}.mp4`)
      await ffmpeg([
        '-ss', frameTime(s.in, fps), '-i', src, '-t', ((s.out - s.in + 1) / fps).toFixed(6),
        '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        out,
      ])
      parts.push(out)
    }
    let final = parts[0]
    if (parts.length > 1) {
      const list = path.join(tmp, 'list.txt')
      fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
      final = path.join(tmp, 'joined.mp4')
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final])
    }
    if (toFile) {
      fs.copyFileSync(final, dest)
      return { savedTo: dest }
    }
    const item = createItem('video', [final])
    item.title = baseName(src) + '_剪辑'
    return { item }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// 范围内去掉重复（静止）帧，回传有变化的帧号；第一帧一定保留
ipcMain.handle('editor:dedupFrames', async (_e, { src, from, to, fps }) => {
  const log = await ffmpeg([
    '-ss', frameTime(from, fps), '-t', ((to - from + 1) / fps).toFixed(6), '-i', src,
    '-vf', 'mpdecimate,showinfo', '-an', '-f', 'null', '-',
  ])
  const ts = [...log.matchAll(/pts_time:([\d.]+)/g)].map(m => +m[1])
  return ts.map(t => from + Math.round((t - ts[0]) * fps)).filter(n => n <= to)
})

// frames: 帧号阵列 -> 每帧一张 PNG，建立序列帧项目
ipcMain.handle('editor:exportFrames', async (_e, { src, frames, fps }) => {
  const tmp = tmpDir()
  try {
    const files = []
    const names = []
    const sorted = [...frames].sort((a, b) => a - b)
    for (const [i, n] of sorted.entries()) {
      const out = path.join(tmp, String(n).padStart(8, '0') + '.png')
      await ffmpeg(['-ss', frameTime(n, fps), '-i', src, '-frames:v', '1', out])
      files.push(out)
      // 档名带时间（第一张 = 0s），例：0006_t0.167s.png
      names.push(`${String(i + 1).padStart(4, '0')}_t${((n - sorted[0]) / fps).toFixed(3)}s.png`)
    }
    const item = createItem('sequence', files, names)
    item.title = baseName(src) + '_序列帧'
    return { item, dirUrl: pathToFileURL(path.join(ITEMS_DIR, item.id)).href }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#16171a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // 自用：允许直接读取本机 file:// 素材
    },
  })
  if (process.argv.includes('--dev')) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
