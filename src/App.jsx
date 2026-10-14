import { useEffect, useMemo, useRef, useState } from 'react'
import Editor from './Editor.jsx'
import { LANGS, setLang as applyLang, t } from './i18n.js'

const api = window.api
const SEQ_FPS = 12 // 序列帧 1x 时的播放 FPS
const VIDEO_STEP = 1 / 60 // 影片逐帧一步的秒数
const SPEEDS = [0.1, 0.25, 0.5, 1, 2]
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i

const SORTS = [
  'custom', 'created-desc', 'created-asc', 'name-asc', 'name-desc',
  'duration-desc', 'duration-asc', 'size-desc', 'size-asc',
]
const RATIOS = [['16 / 9', '16:9'], ['1 / 1', '1:1'], ['9 / 16', '9:16']]

const hasPng = i => i.type === 'sequence' && i.files.some(f => /\.png$/i.test(f))
const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB'

const normTag = t => t.trim().toLowerCase().replace(/\s+/g, ' ')

const durationOf = i =>
  i.type === 'sequence' ? i.files.length / SEQ_FPS : i.type === 'video' ? i.duration || 0 : 0

const COMPARE = {
  custom: (a, b) => a.order - b.order,
  created: (a, b) => a.createdAt - b.createdAt,
  name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
  duration: (a, b) => durationOf(a) - durationOf(b),
  size: (a, b) => (a.size || 0) - (b.size || 0),
}

// 旧项目没有 order：按汇入时间新→旧接在最后
function withOrder(items) {
  const max = Math.max(-1, ...items.filter(i => i.order != null).map(i => i.order))
  const missing = items.filter(i => i.order == null).sort((a, b) => b.createdAt - a.createdAt)
  const pos = new Map(missing.map((i, k) => [i.id, max + 1 + k]))
  return items.map(i => (i.order == null ? { ...i, order: pos.get(i.id) } : i))
}

// 存在 localStorage 的个人设定
function usePref(key, def) {
  const [v, setV] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def }
  })
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)) } catch {}
  }, [key, v])
  return [v, setV]
}

export default function App() {
  const [items, setItems] = useState(null)
  const [base, setBase] = useState('')
  const [query, setQuery] = useState('')
  const [activeTags, setActiveTags] = useState([])
  const [lightbox, setLightbox] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [cols, setCols] = usePref('cols', 3)
  const [ratio, setRatio] = usePref('ratio', '16 / 9')
  const [sort, setSort] = usePref('sort', 'created-desc')
  const [lang, setLang] = usePref('lang', 'zh')
  applyLang(lang)
  const [organizeOn, setOrganizeOn] = useState(false)
  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const organizing = organizeOn && sort === 'custom'
  const [converting, setConverting] = useState([]) // 正在转 JPEG 的项目 id
  const [batch, setBatch] = useState(null) // 一键转换进度 { i, n }

  // Ctrl + 滚轮调整格子大小：往上 = 放大（每行少一格）
  useEffect(() => {
    const onWheel = e => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setCols(c => Math.min(8, Math.max(1, c + (e.deltaY < 0 ? -1 : 1))))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [setCols])

  useEffect(() => {
    api.loadDb().then(db => setItems(withOrder(db.items)))
    api.libDir().then(setBase)
  }, [])

  // 资料变动后延迟存档
  useEffect(() => {
    if (!items) return
    const t = setTimeout(() => api.saveDb({ items }), 400)
    return () => clearTimeout(t)
  }, [items])

  const allTags = useMemo(
    () => [...new Set((items || []).flatMap(i => i.tags))].sort(),
    [items]
  )

  const shown = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    const [key, dir] = sort.split('-')
    const sign = dir === 'desc' ? -1 : 1
    return items
      .filter(i => activeTags.every(t => i.tags.includes(t)))
      .filter(i => !q || [i.title, i.description, ...i.tags].join(' ').toLowerCase().includes(q))
      .sort((a, b) => sign * COMPARE[key](a, b) || b.createdAt - a.createdAt)
  }, [items, query, activeTags, sort])

  // 新项目放在自订顺序的最前面
  function addItems(created) {
    setItems(prev => {
      const min = Math.min(0, ...prev.map(i => i.order))
      return [...created.map((it, k) => ({ ...it, order: min - created.length + k })), ...prev]
    })
  }

  // 把 fromId 移到 toId 的位置，整份重新编号
  function moveItem(fromId, toId) {
    if (fromId === toId) return
    setItems(prev => {
      const list = [...prev].sort((a, b) => a.order - b.order)
      const from = list.findIndex(i => i.id === fromId)
      const forward = from < list.findIndex(i => i.id === toId)
      const [moved] = list.splice(from, 1)
      // 往后拖放在目标之后，往前拖放在目标之前
      list.splice(list.findIndex(i => i.id === toId) + (forward ? 1 : 0), 0, moved)
      const pos = new Map(list.map((i, k) => [i.id, k]))
      return prev.map(i => ({ ...i, order: pos.get(i.id) }))
    })
  }

  async function importPaths(paths) {
    if (!paths.length) return
    const imgCount = paths.filter(p => IMAGE_RE.test(p)).length
    const asSequence = imgCount > 1 && imgCount === paths.length &&
      confirm(t('confirmSequence', { n: imgCount }))
    addItems(await api.importItems(paths, asSequence))
  }

  function update(id, patch) {
    setItems(prev => prev.map(i => (i.id === id ? { ...i, ...patch } : i)))
  }

  async function remove(item) {
    if (!confirm(t('confirmDelete', { title: item.title }))) return
    await api.deleteItem(item.id)
    setItems(prev => prev.filter(i => i.id !== item.id))
  }

  // 序列帧 PNG -> JPEG；回传省下的 bytes，跳过回传 'alpha'，失败丢错误
  async function toJpg(item) {
    setConverting(c => [...c, item.id])
    try {
      const r = await api.toJpg(item.id)
      if (!r) return 0
      if (r.skipped) return r.skipped
      update(item.id, r)
      return (item.size || 0) - r.size
    } finally {
      setConverting(c => c.filter(id => id !== item.id))
    }
  }

  async function toJpgOne(item) {
    try {
      if ((await toJpg(item)) === 'alpha') alert(t('jpgAlpha', { title: item.title }))
    } catch (e) {
      alert(t('jpgFail') + e.message)
    }
  }

  async function toJpgAll() {
    const list = items.filter(hasPng)
    let done = 0, saved = 0
    const skipped = [], failed = []
    for (const [i, item] of list.entries()) {
      setBatch({ i: i + 1, n: list.length })
      try {
        const r = await toJpg(item)
        if (r === 'alpha') skipped.push(item.title)
        else { done++; saved += r }
      } catch {
        failed.push(item.title)
      }
    }
    setBatch(null)
    let msg = t('jpgDone', { n: done, mb: mb(saved) })
    if (skipped.length) msg += '\n\n' + t('jpgSkipped', { n: skipped.length }) + '\n' + skipped.join('\n')
    if (failed.length) msg += '\n\n' + t('jpgFailed', { n: failed.length }) + '\n' + failed.join('\n')
    alert(msg)
  }

  function toggleTag(t) {
    setActiveTags(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]))
  }

  const isFileDrag = e => e.dataTransfer.types.includes('Files')

  function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    if (!isFileDrag(e)) return
    importPaths([...e.dataTransfer.files].map(f => api.pathForFile(f)))
  }

  if (!items) return null

  return (
    <div
      className="app"
      onDragOver={e => { e.preventDefault(); if (isFileDrag(e)) setDragging(true) }}
      onDragLeave={e => { if (!e.relatedTarget) setDragging(false) }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <input
          className="search"
          placeholder={t('search')}
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="count">{shown.length} / {items.length}</span>
        <select value={sort} onChange={e => setSort(e.target.value)}>
          {SORTS.map(v => <option key={v} value={v}>{t('sort.' + v)}</option>)}
        </select>
        <button
          className={organizing ? 'primary' : ''}
          disabled={sort !== 'custom'}
          title={t(sort === 'custom' ? 'organizeHint' : 'organizeNeedCustom')}
          onClick={() => setOrganizeOn(o => !o)}
        >
          {t(organizing ? 'organizeDone' : 'organize')}
        </button>
        <button onClick={() => setEditing(true)}>{t('editorBtn')}</button>
        <button className="primary" onClick={async () => importPaths(await api.openDialog())}>
          {t('import')}
        </button>
        <div className="settings-wrap">
          <button className="icon gear" title={t('settings')} onClick={() => setShowSettings(s => !s)}>⚙</button>
          {showSettings && (
            <>
              <div className="backdrop" onClick={() => setShowSettings(false)} />
              <div className="settings">
                <label>{t('cols')}<b>{cols}</b></label>
                <input
                  type="range"
                  min={1}
                  max={8}
                  value={cols}
                  onChange={e => setCols(Number(e.target.value))}
                />
                <div className="settings-scale"><span>{t('big')}</span><span>{t('small')}</span></div>
                <label>{t('language')}</label>
                <div className="seg-buttons">
                  {LANGS.map(([v, label]) => (
                    <button key={v} className={lang === v ? 'primary' : ''} onClick={() => setLang(v)}>
                      {label}
                    </button>
                  ))}
                </div>
                <label>{t('ratio')}</label>
                <div className="seg-buttons">
                  {RATIOS.map(([v, label]) => (
                    <button key={v} className={ratio === v ? 'primary' : ''} onClick={() => setRatio(v)}>
                      {label}
                    </button>
                  ))}
                </div>
                <label>{t('storage')}</label>
                <button disabled={!!batch || converting.length > 0} onClick={toJpgAll}>
                  {batch ? t('jpgProgress', batch) : t('jpgAll', { n: items.filter(hasPng).length })}
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {allTags.length > 0 && (
        <div className="tagbar">
          {allTags.map(t => (
            <button
              key={t}
              className={'tag' + (activeTags.includes(t) ? ' active' : '')}
              onClick={() => toggleTag(t)}
            >
              #{t}
            </button>
          ))}
          {activeTags.length > 0 && (
            <button className="clear" onClick={() => setActiveTags([])}>{t('clearFilter')}</button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty">{t('empty')}</div>
      ) : (
        <main
          className={'grid' + (organizing ? ' organizing' : '')}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, '--ratio': ratio }}
        >
          {shown.map(item => (
            <Card
              key={item.id}
              item={item}
              dragProps={organizing && {
                draggable: true,
                className: item.id === dragId ? 'drag-src' : item.id === overId ? 'drag-over' : '',
                onDragStart: e => { e.dataTransfer.effectAllowed = 'move'; setDragId(item.id) },
                onDragOver: e => { if (dragId) { e.preventDefault(); setOverId(item.id) } },
                onDrop: e => { e.preventDefault(); e.stopPropagation(); if (dragId) moveItem(dragId, item.id) },
                onDragEnd: () => { setDragId(null); setOverId(null) },
              }}
              base={base}
              allTags={allTags}
              onChange={patch => update(item.id, patch)}
              onDelete={() => remove(item)}
              converting={converting.includes(item.id)}
              onToJpg={!batch && hasPng(item) ? () => toJpgOne(item) : null}
              onTagClick={toggleTag}
              onZoom={setLightbox}
            />
          ))}
        </main>
      )}

      <datalist id="all-tags">
        {allTags.map(t => <option key={t} value={t} />)}
      </datalist>
      {dragging && <div className="dropzone">{t('dropHere')}</div>}
      {editing && (
        <Editor
          onClose={() => setEditing(false)}
          onCreated={item => addItems([item])}
        />
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} />
        </div>
      )}
    </div>
  )
}

function Card({ item, base, allTags, onChange, onDelete, onTagClick, onZoom, dragProps, converting, onToJpg }) {
  const [tagInput, setTagInput] = useState('')
  const urls = item.files.map(f => `${base}/${item.id}/${f}`)

  function addTag() {
    const t = normTag(tagInput)
    setTagInput('')
    if (t && !item.tags.includes(t)) onChange({ tags: [...item.tags, t] })
  }

  return (
    <div
      {...dragProps}
      className={'card ' + (dragProps?.className || '')}
      onContextMenu={async e => {
        e.preventDefault()
        const canJpg = onToJpg && !converting
        const action = await api.itemMenu(item.id, item.files[0], {
          openFolder: t('openFolder'),
          toJpg: canJpg ? t('toJpg', { mb: mb(item.size || 0) }) : null,
        })
        if (action === 'toJpg') onToJpg()
      }}
    >
      {dragProps && <div className="organize-overlay" />}
      {item.type === 'video' && (
        <VideoPlayer
          src={urls[0]}
          onDuration={d => d !== item.duration && isFinite(d) && onChange({ duration: d })}
        />
      )}
      {item.type === 'sequence' && <SequencePlayer srcs={urls} />}
      {item.type === 'image' && (
        <div className="media" onClick={() => onZoom(urls[0])}>
          <img src={urls[0]} style={{ cursor: 'zoom-in' }} />
        </div>
      )}

      <div className="info">
        <div className="row">
          <input
            className="title"
            value={item.title}
            placeholder={t('title')}
            onChange={e => onChange({ title: e.target.value })}
          />
          <span className="badge">{converting ? t('jpgConverting') : t('type.' + item.type)}</span>
          <button className="icon danger" title={t('delete')} onClick={onDelete}>🗑</button>
        </div>
        <textarea
          className="desc"
          rows={3}
          value={item.description}
          placeholder={t('desc')}
          onChange={e => onChange({ description: e.target.value })}
        />
        <div className="tags">
          {item.tags.map(t => (
            <span key={t} className="tag">
              <span onClick={() => onTagClick(t)}>#{t}</span>
              <b onClick={() => onChange({ tags: item.tags.filter(x => x !== t) })}>×</b>
            </span>
          ))}
          <input
            className="tag-input"
            list="all-tags"
            placeholder={t('addTag')}
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTag()}
            onBlur={addTag}
          />
        </div>
      </div>
    </div>
  )
}

function VideoPlayer({ src, onDuration }) {
  const ref = useRef()
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)

  // 播放时用 rAF 更新拖动条，比 timeupdate 顺
  useEffect(() => {
    if (!playing) return
    let raf
    const tick = () => { setTime(ref.current.currentTime); raf = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [playing])

  useEffect(() => { ref.current.playbackRate = rate }, [rate])

  function toggle() {
    const v = ref.current
    v.paused ? v.play() : v.pause()
  }

  function seek(t) {
    ref.current.currentTime = t
    setTime(t)
  }

  function step(dir) {
    ref.current.pause()
    seek(Math.min(duration, Math.max(0, ref.current.currentTime + dir * VIDEO_STEP)))
  }

  return (
    <>
      <div className="media" onClick={toggle}>
        <video
          ref={ref}
          src={src}
          preload="metadata"
          loop
          muted
          onLoadedMetadata={e => { setDuration(e.target.duration); onDuration(e.target.duration) }}
          onPlay={() => setPlaying(true)}
          onPause={() => { setPlaying(false); setTime(ref.current.currentTime) }}
        />
      </div>
      <Controls
        playing={playing}
        onToggle={toggle}
        value={time}
        max={duration}
        step={0.001}
        onSeek={seek}
        onStep={step}
        label={`${time.toFixed(2)}s / ${duration.toFixed(2)}s`}
        rate={rate}
        setRate={setRate}
      />
    </>
  )
}

function SequencePlayer({ srcs }) {
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)

  // 预先载入所有帧，避免播放时闪烁
  useEffect(() => { srcs.forEach(s => { new Image().src = s }) }, [srcs])

  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setFrame(f => (f + 1) % srcs.length), 1000 / (SEQ_FPS * rate))
    return () => clearTimeout(t)
  }, [playing, frame, rate, srcs.length])

  function step(dir) {
    setPlaying(false)
    setFrame(f => (f + dir + srcs.length) % srcs.length)
  }

  return (
    <>
      <div className="media" onClick={() => setPlaying(p => !p)}>
        <img src={srcs[frame]} />
      </div>
      <Controls
        playing={playing}
        onToggle={() => setPlaying(p => !p)}
        value={frame}
        max={srcs.length - 1}
        step={1}
        onSeek={f => { setPlaying(false); setFrame(f) }}
        onStep={step}
        label={t('frameCount', { a: frame + 1, b: srcs.length })}
        rate={rate}
        setRate={setRate}
      />
    </>
  )
}

function Controls({ playing, onToggle, value, max, step, onSeek, onStep, label, rate, setRate }) {
  const [custom, setCustom] = useState('')

  function applyCustom() {
    const r = parseFloat(custom)
    if (r > 0) setRate(Math.min(16, Math.max(0.0625, r)))
    setCustom('')
  }

  return (
    <div className="controls">
      <input
        type="range"
        className="scrubber"
        min={0}
        max={max || 0}
        step={step}
        value={value}
        onChange={e => onSeek(Number(e.target.value))}
      />
      <div className="row">
        <button className="icon" onClick={() => onStep(-1)} title={t('prevFrame')}>⏮</button>
        <button className="icon play" onClick={onToggle}>{playing ? '⏸' : '▶'}</button>
        <button className="icon" onClick={() => onStep(1)} title={t('nextFrame')}>⏭</button>
        <span className="time">{label}</span>
        <div className="speeds">
          {SPEEDS.map(s => (
            <button key={s} className={rate === s ? 'active' : ''} onClick={() => setRate(s)}>
              {s}x
            </button>
          ))}
          <input
            className={'custom-rate' + (SPEEDS.includes(rate) ? '' : ' active')}
            placeholder={SPEEDS.includes(rate) ? t('customRate') : rate + 'x'}
            value={custom}
            onChange={e => setCustom(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyCustom()}
            onBlur={applyCustom}
          />
        </div>
      </div>
    </div>
  )
}
