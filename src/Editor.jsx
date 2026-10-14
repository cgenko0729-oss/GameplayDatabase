import { useEffect, useRef, useState } from 'react'
import { t as tr } from './i18n.js'

const api = window.api
const THUMB_W = 160

const fmt = s => {
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`
}

// 录屏剪辑器：片段 (I/O) -> 导出影片；勾选帧 (F) -> 导出序列帧
export default function Editor({ onClose, onCreated }) {
  const videoRef = useRef()
  const [info, setInfo] = useState(null) // { path, url, fps, duration, hasAudio }
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [inF, setInF] = useState(null)
  const [segments, setSegments] = useState([]) // [{ in, out }]
  const [marks, setMarks] = useState([]) // [{ frame, thumb }]
  const [busy, setBusy] = useState('')
  const [autoStep, setAutoStep] = useState(3)
  const [dedup, setDedup] = useState(false)

  const fps = info?.fps || 60
  const total = info ? Math.max(1, Math.floor(info.duration * fps)) : 1
  const t = f => f / fps

  async function open(src) {
    const r = await api.editorOpen(src)
    if (!r) return
    setInfo(r)
    setFrame(0)
    setInF(null)
    setSegments([])
    setMarks([])
  }

  function seek(n) {
    const v = videoRef.current
    if (!v || !info) return
    n = Math.min(total - 1, Math.max(0, Math.round(n)))
    v.pause()
    v.currentTime = (n + 0.5) / fps // 落在帧中间，避免显示到前一帧
    setFrame(n)
  }

  function toggle() {
    const v = videoRef.current
    if (v) v.paused ? v.play() : v.pause()
  }

  function addSegment(cur = frame) {
    if (inF == null) return
    const s = { in: Math.min(inF, cur), out: Math.max(inF, cur) }
    setSegments(prev => [...prev, s].sort((a, b) => a.in - b.in))
    setInF(null)
  }

  async function toggleMark(cur = frame) {
    if (marks.some(m => m.frame === cur)) {
      setMarks(prev => prev.filter(m => m.frame !== cur))
      return
    }
    addMarks([{ frame: cur, thumb: await captureThumb() }])
  }

  // 截目前画面当缩图（等 seek 完成）
  async function captureThumb() {
    const v = videoRef.current
    if (v.seeking) await new Promise(r => v.addEventListener('seeked', r, { once: true }))
    const c = document.createElement('canvas')
    c.width = THUMB_W
    c.height = Math.round((THUMB_W * v.videoHeight) / v.videoWidth) || 90
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.7)
  }

  const addMarks = list =>
    setMarks(prev => {
      const map = new Map(prev.map(m => [m.frame, m]))
      list.forEach(m => map.set(m.frame, m))
      return [...map.values()].sort((a, b) => a.frame - b.frame)
    })

  // 入点 ~ 当前帧：（可选去重复帧后）每 N 帧取一张，追加进勾选列表
  async function autoPick() {
    if (inF == null || busy) return
    const from = Math.min(inF, frame)
    const to = Math.max(inF, frame)
    const back = frame
    setBusy(tr('ed.analyzing'))
    try {
      let cands = Array.from({ length: to - from + 1 }, (_, i) => from + i)
      if (dedup) cands = await api.dedupFrames({ src: info.path, from, to, fps })
      const step = Math.max(1, Math.floor(autoStep) || 1)
      const have = new Set(marks.map(m => m.frame))
      const picked = cands.filter((_, i) => i % step === 0).filter(n => !have.has(n))
      const list = []
      for (const [i, n] of picked.entries()) {
        setBusy(tr('ed.thumbs', { i: i + 1, n: picked.length }))
        seek(n)
        list.push({ frame: n, thumb: await captureThumb() })
      }
      addMarks(list)
      seek(back)
    } catch (e) {
      alert(tr('ed.autoFail') + e.message)
    } finally {
      setBusy('')
    }
  }

  async function run(label, fn) {
    setBusy(label)
    try {
      const r = await fn()
      if (r?.item) onCreated(r.item)
      if (r?.savedTo) alert(tr('ed.savedTo') + r.savedTo)
      if (r?.item) alert(tr('ed.added') + r.item.title)
    } catch (e) {
      alert(tr('ed.exportFail') + e.message)
    } finally {
      setBusy('')
    }
  }

  const exportVideo = toFile =>
    run(tr('ed.exportingVideo'), () =>
      api.exportVideo({ src: info.path, segments, fps, hasAudio: info.hasAudio, toFile })
    )

  const exportFrames = () =>
    run(tr('ed.exportingFrames', { n: marks.length }), async () => {
      const frames = marks.map(m => m.frame)
      const r = await api.exportFrames({ src: info.path, frames, fps })
      const meta = { src: info.path.split(/[\\/]/).pop(), fps, frames, files: r.item.files }
      await api.writeItemFile(r.item.id, 'timeline.txt', timelineText(meta))
      await api.writeItemFile(r.item.id, 'overview.jpg', await buildOverview(meta, r.dirUrl))
      setMarks([])
      return r
    })

  // 播放时用 rAF 同步帧号
  useEffect(() => {
    if (!playing) return
    let raf
    const tick = () => {
      setFrame(Math.floor(videoRef.current.currentTime * fps))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [playing, fps])

  // 快捷键（每次 render 重新绑定，拿到最新 state）
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || busy) return
      if (e.target.tagName === 'BUTTON') e.target.blur() // 避免 Space 同时触发按钮
      const k = e.key.toLowerCase()
      if (k === 'escape') return onClose()
      if (!info) return
      const cur = playing ? Math.floor(videoRef.current.currentTime * fps) : frame
      if (k === ' ') toggle()
      else if (k === 'arrowleft') seek(cur - (e.shiftKey ? 10 : 1))
      else if (k === 'arrowright') seek(cur + (e.shiftKey ? 10 : 1))
      else if (k === 'i') setInF(cur)
      else if (k === 'o') { if (playing) seek(cur); addSegment(cur) }
      else if (k === 'f') { if (playing) seek(cur); toggleMark(cur) }
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function onDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer.files[0]
    if (f) open(api.pathForFile(f))
  }

  return (
    <div
      className="editor"
      onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <button className="primary" onClick={() => open()}>{tr('ed.open')}</button>
        <span className="ed-file">
          {info
            ? `${info.path.split(/[\\/]/).pop()}　${+fps.toFixed(3)}fps　${fmt(info.duration)}${info.hasAudio ? '' : '　' + tr('ed.noAudio')}`
            : tr('ed.dropHint')}
        </span>
        <span className="ed-help">{tr('ed.help')}</span>
        <button onClick={onClose}>{tr('ed.close')}</button>
      </header>

      <div className="ed-stage" onClick={toggle}>
        {info && (
          <video
            ref={videoRef}
            src={info.url}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedData={() => seek(0)}
          />
        )}
      </div>

      {info && (
        <>
          <div className="ed-transport">
            <button className="icon" onClick={() => seek(frame - 1)}>⏮</button>
            <button className="icon play" onClick={toggle}>{playing ? '⏸' : '▶'}</button>
            <button className="icon" onClick={() => seek(frame + 1)}>⏭</button>
            <span className="time">{fmt(t(frame))}　{tr('ed.frameOf', { f: frame, n: total - 1 })}</span>
            <button onClick={() => setInF(frame)}>{tr('ed.in')}</button>
            <button onClick={() => addSegment()} disabled={inF == null}>{tr('ed.out')}</button>
            <button onClick={() => toggleMark()}>
              {tr(marks.some(m => m.frame === frame) ? 'ed.unmark' : 'ed.mark')}
            </button>
            {inF != null && <span className="ed-pending">{tr('ed.inAt', { t: fmt(t(inF)), f: inF })}</span>}
            <span className="ed-auto">
              {tr('ed.autoEvery')}
              <input type="number" min={1} value={autoStep} onChange={e => setAutoStep(e.target.value)} />
              {tr('ed.autoFrames')}
              <label><input type="checkbox" checked={dedup} onChange={e => setDedup(e.target.checked)} /> {tr('ed.dedup')}</label>
              <button className="primary" disabled={inF == null || !!busy} onClick={autoPick} title={tr('ed.autoTip')}>
                {tr('ed.autoBtn')}
              </button>
            </span>
          </div>

          <Timeline
            total={total}
            frame={frame}
            inF={inF}
            segments={segments}
            marks={marks}
            onSeek={seek}
          />

          <div className="ed-panels">
            <section>
              <h3>{tr('ed.segments')} <small>{tr('ed.segSummary', { n: segments.length, t: fmt(t(segments.reduce((a, s) => a + s.out - s.in + 1, 0))) })}</small></h3>
              <div className="ed-list">
                {segments.map((s, i) => (
                  <div key={i} className="ed-seg" onClick={() => seek(s.in)}>
                    <span>{i + 1}.</span>
                    <span>{fmt(t(s.in))} ~ {fmt(t(s.out + 1))}</span>
                    <small>{tr('ed.nFrames', { n: s.out - s.in + 1 })}</small>
                    <b onClick={e => { e.stopPropagation(); setSegments(prev => prev.filter((_, j) => j !== i)) }}>✕</b>
                  </div>
                ))}
                {!segments.length && <div className="ed-hint">{tr('ed.segHint')}</div>}
              </div>
              <div className="ed-actions">
                <button className="primary" disabled={!segments.length || busy} onClick={() => exportVideo(false)}>{tr('ed.saveLib')}</button>
                <button disabled={!segments.length || busy} onClick={() => exportVideo(true)}>{tr('ed.saveAs')}</button>
              </div>
            </section>

            <section>
              <h3>{tr('ed.marks')} <small>{tr('ed.nFrames', { n: marks.length })}</small></h3>
              <div className="ed-list ed-thumbs">
                {marks.map(m => (
                  <div key={m.frame} className={'ed-thumb' + (m.frame === frame ? ' active' : '')} onClick={() => seek(m.frame)}>
                    <img src={m.thumb} />
                    <span>#{m.frame}</span>
                    <b onClick={e => { e.stopPropagation(); setMarks(prev => prev.filter(x => x.frame !== m.frame)) }}>✕</b>
                  </div>
                ))}
                {!marks.length && <div className="ed-hint">{tr('ed.markHint')}</div>}
              </div>
              <div className="ed-actions">
                <button className="primary" disabled={!marks.length || busy} onClick={exportFrames}>{tr('ed.exportSeq')}</button>
                <button disabled={!marks.length || busy} onClick={() => setMarks([])}>{tr('ed.clear')}</button>
              </div>
            </section>
          </div>
        </>
      )}

      {busy && <div className="ed-busy">{busy}</div>}
    </div>
  )
}

const sec = x => x.toFixed(3) + 's'

// 时间轴文字档：给 AI 分析用，时间从第一张起算
function timelineText({ src, fps, frames, files }) {
  const rel = frames.map(n => (n - frames[0]) / fps)
  const span = rel[rel.length - 1]
  const cols = tr('tl.cols').split('|')
  const rows = frames.map((n, i) => [
    i + 1, files[i], sec(rel[i]), i ? '+' + sec(rel[i] - rel[i - 1]) : '-', n, sec(n / fps),
  ])
  // 中日文字占两格宽，按显示宽度对齐
  const dw = v => [...String(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  const w = cols.map((c, j) => Math.max(dw(c), ...rows.map(r => dw(r[j]))) + 2)
  const line = r => r.map((v, j) => v + ' '.repeat(w[j] - dw(v))).join('').trimEnd()
  const last = frames[frames.length - 1]
  return [
    tr('tl.source') + src,
    tr('tl.fps') + +fps.toFixed(3) + 'fps',
    tr('tl.count') + frames.length,
    tr('tl.base'),
    tr('tl.span') + sec(span),
    tr('tl.total') + sec(span + 1 / fps),
    tr('tl.range', { a: frames[0], ta: sec(frames[0] / fps), b: last, tb: sec(last / fps) }),
    '',
    line(cols),
    ...rows.map(line),
    '',
  ].join('\r\n')
}

// 总览图：所有帧拼成网格，每格标时间，一张图丢给 AI
async function buildOverview({ src, fps, frames, files }, dirUrl) {
  const imgs = await Promise.all(files.map(f => new Promise((res, rej) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = rej
    im.src = `${dirUrl}/${encodeURIComponent(f)}`
  })))
  const n = imgs.length
  const fw = imgs[0].naturalWidth
  const fh = imgs[0].naturalHeight
  const HEAD = 56, LABEL = 30, GAP = 6, MAX_W = 2400
  // 让整张图大约 16:9
  const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt(((16 / 9) * n * fh) / fw))))
  const cw = Math.min(fw, Math.floor((MAX_W - GAP * (cols + 1)) / cols))
  const ch = Math.round((cw * fh) / fw)
  const rows = Math.ceil(n / cols)
  const c = document.createElement('canvas')
  c.width = cols * cw + GAP * (cols + 1)
  c.height = HEAD + rows * (ch + LABEL + GAP) + GAP
  const g = c.getContext('2d')
  const font = (px, bold) => `${bold ? 'bold ' : ''}${px}px "Segoe UI", "Microsoft YaHei", "Yu Gothic", sans-serif`
  const rel = i => (frames[i] - frames[0]) / fps
  g.fillStyle = '#16171a'
  g.fillRect(0, 0, c.width, c.height)
  g.textBaseline = 'middle'
  g.fillStyle = '#fff'
  g.font = font(24, true)
  g.fillText(tr('ov.head', { src, total: sec(rel(n - 1) + 1 / fps), fps: +fps.toFixed(3), n }), GAP + 4, HEAD / 2)
  imgs.forEach((im, i) => {
    const x = GAP + (i % cols) * (cw + GAP)
    const y = HEAD + Math.floor(i / cols) * (ch + LABEL + GAP)
    const ly = y + ch + LABEL / 2
    g.drawImage(im, x, y, cw, ch)
    g.font = font(17, true)
    g.fillStyle = '#fff'
    g.fillText(`#${i + 1}  ${sec(rel(i))}`, x + 2, ly)
    if (i) {
      g.font = font(14)
      g.fillStyle = '#8b8e96'
      g.textAlign = 'right'
      g.fillText('+' + sec(rel(i) - rel(i - 1)), x + cw - 2, ly)
      g.textAlign = 'left'
    }
  })
  return c.toDataURL('image/jpeg', 0.9)
}

function Timeline({ total, frame, inF, segments, marks, onSeek }) {
  const ref = useRef()
  const pct = f => (f / total) * 100 + '%'

  function seekAt(e) {
    const r = ref.current.getBoundingClientRect()
    onSeek(((e.clientX - r.left) / r.width) * total)
  }

  return (
    <div
      ref={ref}
      className="ed-timeline"
      onPointerDown={e => { ref.current.setPointerCapture(e.pointerId); seekAt(e) }}
      onPointerMove={e => e.buttons && seekAt(e)}
    >
      {segments.map((s, i) => (
        <div key={i} className="ed-tl-seg" style={{ left: pct(s.in), width: pct(s.out - s.in + 1) }} />
      ))}
      {marks.map(m => <div key={m.frame} className="ed-tl-mark" style={{ left: pct(m.frame) }} />)}
      {inF != null && <div className="ed-tl-in" style={{ left: pct(inF) }} />}
      <div className="ed-tl-head" style={{ left: pct(frame) }} />
    </div>
  )
}
