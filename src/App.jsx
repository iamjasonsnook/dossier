import { useState, useCallback, useRef, useEffect } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument, degrees } from 'pdf-lib'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragOverlay, useDraggable, useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './App.css'

GlobalWorkerOptions.workerSrc = workerUrl

let _uid = 0
const uid = () => `id-${++_uid}-${Math.random().toString(36).slice(2, 7)}`
const wasmUrl = new URL('wasm/', window.location.href).href
const PREVIEW_WIDTH = 900 // px width used by renderPreview — used to scale fonts at export

// One font stack shared by the on-screen text box AND the export canvas, so
// wrap points and glyph positions match exactly (fixes text shifting on export).
const ANNOT_FONT = 'Helvetica, Arial, sans-serif'
const ANNOT_LINE_RATIO = 1.4

// Signature styles (loaded in index.html): three elegant scripts plus one clean
// print style for people who prefer a plain typed signature.
const SIGNATURE_FONTS = [
  { id: 'alex', label: 'Alex Brush', css: "'Alex Brush', cursive" },
  { id: 'vibes', label: 'Great Vibes', css: "'Great Vibes', cursive" },
  { id: 'sacramento', label: 'Sacramento', css: "'Sacramento', cursive" },
  { id: 'print', label: 'Print', css: "'Inter', sans-serif" },
]
const DEFAULT_SIG_FONT = SIGNATURE_FONTS[0].css

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Rotation is stored per output page as a clockwise delta on the page's own /Rotate. */
const normalizeRotation = (deg) => ((deg % 360) + 360) % 360

/**
 * Turning the page turns everything drawn on it. Marks are stored as fractions
 * of the page box, so a clockwise quarter turn sends (x, y) to (1 - y - h, x)
 * and swaps width for height.
 *
 * Redaction rectangles pass through this exactly. A text or signature box has
 * no stored height, so it goes through with h = 0: the anchor lands in the
 * right place and the wrap width is left alone, which keeps the text where it
 * belongs on the page even though a quarter turn may re-wrap it.
 */
function rotateFractionalRect({ x, y, w = 0, h = 0 }, delta) {
  switch (normalizeRotation(delta)) {
    case 90: return { x: 1 - y - h, y: x, w: h, h: w }
    case 180: return { x: 1 - x - w, y: 1 - y - h, w, h }
    case 270: return { x: y, y: 1 - x - w, w: h, h: w }
    default: return { x, y, w, h }
  }
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1]
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function renderThumb(page, displayWidth = 176, rotation = 0) {
  // getViewport's rotation is absolute, not additive, so the page's own
  // /Rotate has to be folded in or rotating would discard it.
  const nativeVp = page.getViewport({ scale: 1, rotation: page.rotate + rotation })
  const renderCanvas = document.createElement('canvas')
  renderCanvas.width = Math.ceil(nativeVp.width)
  renderCanvas.height = Math.ceil(nativeVp.height)
  await page.render({ canvas: renderCanvas, viewport: nativeVp }).promise
  const scale = displayWidth / nativeVp.width
  const tw = Math.round(nativeVp.width * scale)
  const th = Math.round(nativeVp.height * scale)
  const thumbCanvas = document.createElement('canvas')
  thumbCanvas.width = tw
  thumbCanvas.height = th
  thumbCanvas.getContext('2d').drawImage(renderCanvas, 0, 0, tw, th)
  const dataUrl = thumbCanvas.toDataURL('image/jpeg', 0.85)
  renderCanvas.width = 0
  renderCanvas.height = 0
  return dataUrl
}

async function renderPreview(pdfBytes, pageIndex, rotation = 0) {
  const buf = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)
  const pdfDoc = await getDocument({ data: buf, wasmUrl }).promise
  const page = await pdfDoc.getPage(pageIndex + 1)
  // Rendering the preview already rotated keeps the annotation overlay square
  // with what the user sees, so pointer coordinates need no correction.
  return renderThumb(page, PREVIEW_WIDTH, rotation)
}

// Ensure the signature script fonts are ready in the canvas before drawing.
async function ensureSignatureFonts() {
  try {
    await Promise.all(SIGNATURE_FONTS.map(f =>
      document.fonts.load(`48px ${f.css}`)
    ))
  } catch (_) {}
}

// Word-wrapped text for canvas, top-aligned to mirror a textarea with padding:0
// and line-height 1.4 (glyphs vertically centered within each line box). Greedy
// word wrap on spaces — the same algorithm browsers use — so lines break at the
// same points as the on-screen box.
function canvasDrawText(ctx, text, x, top, maxWidth, fontSize, lineHeight) {
  ctx.textBaseline = 'top'
  const leading = (lineHeight - fontSize) / 2 // matches the textarea's line-box centering
  let lineIdx = 0
  const drawLine = (line) => {
    ctx.fillText(line, x, top + lineIdx * lineHeight + leading)
    lineIdx++
  }
  for (const para of text.split('\n')) {
    if (!para.trim()) { lineIdx++; continue }
    let line = ''
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxWidth && line) { drawLine(line); line = word }
      else line = test
    }
    if (line) drawLine(line)
  }
}

// ─── Drag-handle hook — shared by TextAnnotation and SignatureAnnotation ─────

function useDragHandle(overlayRef, annotation, onUpdate) {
  const ref = useRef(null)

  const onPointerDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return
    ref.current = { sx: e.clientX / r.width, sy: e.clientY / r.height, ox: annotation.x, oy: annotation.y }
  }
  const onPointerMove = (e) => {
    if (!ref.current) return
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return
    onUpdate(annotation.id, {
      x: Math.max(0, ref.current.ox + e.clientX / r.width - ref.current.sx),
      y: Math.max(0, ref.current.oy + e.clientY / r.height - ref.current.sy),
    })
  }
  const onPointerUp = () => { ref.current = null }
  return { onPointerDown, onPointerMove, onPointerUp }
}

// ─── TextAnnotation ───────────────────────────────────────────────────────────

function TextAnnotation({ annotation, overlayRef, containerWidth, onUpdate, onRemove }) {
  const drag = useDragHandle(overlayRef, annotation, onUpdate)
  const resizeRef = useRef(null)
  const textareaRef = useRef(null)

  // Auto-size textarea height whenever text changes
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [annotation.text])

  // Focus on creation
  useEffect(() => { if (annotation.text === '') textareaRef.current?.focus() }, [])

  const onResizePointerDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return
    resizeRef.current = { sx: e.clientX / r.width, ow: annotation.w }
  }
  const onResizePointerMove = (e) => {
    if (!resizeRef.current) return
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return
    const dx = e.clientX / r.width - resizeRef.current.sx
    onUpdate(annotation.id, { w: Math.max(0.12, Math.min(0.98, resizeRef.current.ow + dx)) })
  }
  const onResizePointerUp = () => { resizeRef.current = null }

  // Exact (unrounded) size keeps wrap points identical to export.
  const fontSize = annotation.fontSize * (containerWidth / PREVIEW_WIDTH)

  return (
    <div
      className="annotation text-annotation"
      style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%`, width: `${annotation.w * 100}%` }}
    >
      {/* Skinny drag grip on the left edge */}
      <button
        className="annot-side-grip" title="Drag to move"
        onPointerDown={(e) => { e.stopPropagation(); drag.onPointerDown(e) }}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
      ><GripIcon /></button>
      {/* Delete in the upper-right, opposite the resizer */}
      <button
        className="annot-corner-del" title="Delete"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onRemove(annotation.id) }}
      ><CloseIcon /></button>
      <textarea
        ref={textareaRef}
        className="annotation-textarea"
        value={annotation.text}
        style={{ fontFamily: ANNOT_FONT, fontSize: `${fontSize}px`, lineHeight: ANNOT_LINE_RATIO }}
        onChange={e => onUpdate(annotation.id, { text: e.target.value })}
        onPointerDown={e => e.stopPropagation()}
        placeholder="Type here…"
        rows={1}
      />
      <div
        className="annotation-resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
      />
    </div>
  )
}

// ─── SignatureAnnotation ──────────────────────────────────────────────────────

function SignatureAnnotation({ annotation, overlayRef, containerWidth, onUpdate, onRemove }) {
  const drag = useDragHandle(overlayRef, annotation, onUpdate)
  const inputRef = useRef(null)
  const [draft, setDraft] = useState(annotation.text || '')

  useEffect(() => {
    if (annotation.inputMode) inputRef.current?.focus()
  }, [annotation.inputMode])

  const font = annotation.font || DEFAULT_SIG_FONT

  const commit = () => {
    const text = draft.trim()
    if (!text) { onRemove(annotation.id); return }
    onUpdate(annotation.id, { text, inputMode: false })
  }

  const fontSize = annotation.fontSize * (containerWidth / PREVIEW_WIDTH)

  const resizeDragRef = useRef(null)
  const onResizePointerDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return
    resizeDragRef.current = { sx: e.clientX / r.width, oSize: annotation.fontSize }
  }
  const onResizePointerMove = (e) => {
    if (!resizeDragRef.current) return
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return
    const dx = e.clientX / r.width - resizeDragRef.current.sx
    onUpdate(annotation.id, { fontSize: Math.max(18, Math.min(140, resizeDragRef.current.oSize + dx * 260)) })
  }
  const onResizePointerUp = () => { resizeDragRef.current = null }

  if (annotation.inputMode) {
    const preview = draft.trim() || 'Signature'
    // Keep the popover inside the page: open leftward past the middle,
    // and open upward in the lower part of the page.
    const anchorRight = annotation.x > 0.5
    const anchorUp = annotation.y > 0.45
    return (
      <div
        className={`annotation signature-annotation input-mode${anchorRight ? ' anchor-right' : ''}${anchorUp ? ' anchor-up' : ''}`}
        style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
        onPointerDown={e => e.stopPropagation()}
      >
        <div className="sig-input-row">
          <input
            ref={inputRef}
            className="signature-input"
            value={draft}
            placeholder="Type your name"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              if (e.key === 'Escape') { e.preventDefault(); onRemove(annotation.id) }
            }}
          />
          <button className="sig-add-btn" onClick={commit} disabled={!draft.trim()}>Add</button>
        </div>
        <div className="sig-style-label">Choose a style</div>
        <div className="sig-style-row">
          {SIGNATURE_FONTS.map(f => (
            <button
              key={f.id} type="button"
              className={`sig-style${font === f.css ? ' is-active' : ''}`}
              style={{ fontFamily: f.css }}
              onClick={() => onUpdate(annotation.id, { font: f.css })}
              title={f.label}
            >{preview}</button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className="annotation signature-annotation"
      style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
    >
      {/* Skinny drag grip on the left edge */}
      <button
        className="annot-side-grip" title="Drag to move"
        onPointerDown={(e) => { e.stopPropagation(); drag.onPointerDown(e) }}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
      ><GripIcon /></button>
      {/* Delete in the upper-right, opposite the resizer */}
      <button
        className="annot-corner-del" title="Delete"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onRemove(annotation.id) }}
      ><CloseIcon /></button>
      <span
        className="signature-text" title="Click to edit"
        style={{ fontFamily: font, fontSize: `${fontSize}px` }}
        onClick={e => { e.stopPropagation(); setDraft(annotation.text || ''); onUpdate(annotation.id, { inputMode: true }) }}
      >
        {annotation.text}
      </span>
      <div
        className="annotation-resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        title="Drag to resize"
      />
    </div>
  )
}

// ─── Small shell components ───────────────────────────────────────────────────

function GripIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
      <circle cx="3.5" cy="2.5" r="1.3" /><circle cx="8.5" cy="2.5" r="1.3" />
      <circle cx="3.5" cy="7" r="1.3" /><circle cx="8.5" cy="7" r="1.3" />
      <circle cx="3.5" cy="11.5" r="1.3" /><circle cx="8.5" cy="11.5" r="1.3" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  )
}

// Tool icons for the preview toolbar
function RedactIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="2.5" y="7.5" width="15" height="5" rx="1" fill="currentColor" />
      <path d="M3 4h9M3 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".4" />
    </svg>
  )
}
function TextIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5h12M10 5.5V15M7.5 15h5" />
    </svg>
  )
}
function SignatureIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 13.5c2.5.3 3.8-1 4.4-3.2.5-2 .8-4.6 2-4.6 1 0 .8 2.2 1.5 2.2.6 0 1-1.2 1.9-1.2.8 0 .8 1.5 1.6 1.5.6 0 1-.6 1.6-.6" />
      <path d="M2.5 16.5h15" opacity=".45" />
    </svg>
  )
}

function RotateIcon({ ccw = false }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      style={ccw ? { transform: 'scaleX(-1)' } : undefined} aria-hidden="true"
    >
      <path d="M13 6.5A5.2 5.2 0 1 0 8 13" />
      <path d="M13 2.5v4h-4" />
    </svg>
  )
}

function SortablePage({ page, onRemove, onRotate, onPreview }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id })
  const modCount = (page.redactions?.length || 0) + (page.annotations?.length || 0)
  const rotation = normalizeRotation(page.rotation || 0)
  return (
    <div
      ref={setNodeRef}
      className={`output-card${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="output-card-grip" {...attributes} {...listeners}><GripIcon /></div>
      {/* Square box, so a quarter turn never changes the card's height. */}
      <div className="output-card-thumb-wrap">
        <img
          src={page.thumbUrl} className="output-card-thumb" alt=""
          onClick={() => onPreview(page.sourceId, page.pageIndex)}
          style={{ cursor: 'zoom-in', transform: `rotate(${rotation}deg)` }}
        />
      </div>
      <div className="output-card-meta">
        <span className="output-card-file" title={page.sourceName}>{page.sourceName}</span>
        <span className="output-card-page">
          p. {page.pageIndex + 1}
          {rotation > 0 && <span className="rotated-badge">{rotation}°</span>}
          {modCount > 0 && <span className="modified-badge">{modCount} marked</span>}
        </span>
      </div>
      <button
        className="output-card-rotate" onClick={() => onRotate(page.id, 90)}
        title="Rotate right 90°"
      ><RotateIcon /></button>
      <button className="output-card-remove" onClick={() => onRemove(page.id)} title="Remove">×</button>
    </div>
  )
}

function DraggableSourceThumb({ pdf, page, isAdded, onClick }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `src-${pdf.id}-${page.pageIndex}`,
    data: { type: 'source-page', pdf, page },
  })
  return (
    <button
      ref={setNodeRef}
      className={`source-thumb${isAdded ? ' is-added' : ''}${!page.thumbUrl ? ' render-failed' : ''}`}
      style={{ opacity: isDragging ? 0.3 : undefined }}
      onClick={onClick}
      title={`Page ${page.pageIndex + 1}${isAdded ? ' — in tray' : ' — click to preview · drag to add'}`}
      {...attributes} {...listeners}
    >
      {page.thumbUrl ? <img src={page.thumbUrl} alt="" /> : <span className="thumb-err">?</span>}
      <span className="thumb-num">{page.pageIndex + 1}</span>
      {isAdded && <span className="thumb-check">✓</span>}
    </button>
  )
}

function OutputDropZone({ children, hasCards }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'output-tray' })
  return (
    <div ref={setNodeRef} className={`output-scroll${isOver && !hasCards ? ' drop-over' : ''}`}>
      {children}
    </div>
  )
}

// ─── PagePreview ──────────────────────────────────────────────────────────────

function PagePreview({ item, sourcePdfs, outputPages, addPage, onRotate, onAddRedaction, onRemoveRedaction, onAddAnnotation, onUpdateAnnotation, onRemoveAnnotation, onClose }) {
  const pdf = sourcePdfs.find(p => p.id === item.pdfId)
  const [currentIndex, setCurrentIndex] = useState(item.pageIndex)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTool, setActiveTool] = useState(null) // null | 'redact' | 'text' | 'signature'
  const [drawingRect, setDrawingRect] = useState(null)
  const [containerWidth, setContainerWidth] = useState(PREVIEW_WIDTH)
  const overlayRef = useRef(null)
  const pointerDownPos = useRef(null)

  const totalPages = pdf?.pages.length ?? 0
  const addedSet = new Set(outputPages.map(p => p.sourcePageId))
  const currentSourcePageId = `${item.pdfId}::${currentIndex}`
  const currentIsAdded = addedSet.has(currentSourcePageId)
  const currentPage = pdf?.pages.find(p => p.pageIndex === currentIndex)
  const outputPage = outputPages.find(p => p.sourceId === item.pdfId && p.pageIndex === currentIndex)
  const redactions = outputPage?.redactions || []
  const annotations = outputPage?.annotations || []
  const rotation = normalizeRotation(outputPage?.rotation || 0)

  // Render high-res preview, already rotated so the overlay lines up with it
  useEffect(() => {
    if (!pdf?.bytes) return
    let cancelled = false
    setLoading(true)
    setPreviewUrl(null)
    renderPreview(pdf.bytes, currentIndex, rotation)
      .then(url => { if (!cancelled) { setPreviewUrl(url); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [pdf, currentIndex, rotation])

  // Reset tool when navigating pages
  useEffect(() => {
    setActiveTool(null)
    setDrawingRect(null)
  }, [currentIndex])

  // Track overlay width for proportional font sizing
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [previewUrl])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (activeTool) { setActiveTool(null); return }
        onClose()
      }
      if (e.key === 'ArrowLeft' && currentIndex > 0) setCurrentIndex(i => i - 1)
      if (e.key === 'ArrowRight' && currentIndex < totalPages - 1) setCurrentIndex(i => i + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentIndex, totalPages, activeTool, onClose])

  // Normalized coords from pointer event relative to overlay
  const normCoords = (e) => {
    const r = overlayRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    }
  }

  // ── Overlay pointer handlers ─────────────────────────────────────────────

  const onOverlayPointerDown = (e) => {
    // Clicks on annotations or redaction elements are handled by those elements
    if (e.target.closest('.annotation, .redaction-box')) return

    pointerDownPos.current = { x: e.clientX, y: e.clientY }

    if (activeTool === 'redact') {
      e.preventDefault()
      const { x, y } = normCoords(e)
      setDrawingRect({ sx: x, sy: y, cx: x, cy: y })
      overlayRef.current?.setPointerCapture(e.pointerId)
    }
  }

  const onOverlayPointerMove = (e) => {
    if (activeTool === 'redact' && drawingRect) {
      const { x, y } = normCoords(e)
      setDrawingRect(r => ({ ...r, cx: x, cy: y }))
    }
  }

  const onOverlayPointerUp = (e) => {
    if (activeTool === 'redact' && drawingRect) {
      const minX = Math.min(drawingRect.sx, drawingRect.cx)
      const minY = Math.min(drawingRect.sy, drawingRect.cy)
      const w = Math.abs(drawingRect.cx - drawingRect.sx)
      const h = Math.abs(drawingRect.cy - drawingRect.sy)
      if (outputPage && w > 0.01 && h > 0.01) {
        onAddRedaction(outputPage.id, { x: minX, y: minY, w, h })
      }
      setDrawingRect(null)
      return
    }

    // Click detection for text/signature placement
    if (!pointerDownPos.current) return
    const moved = Math.hypot(e.clientX - pointerDownPos.current.x, e.clientY - pointerDownPos.current.y)
    pointerDownPos.current = null
    if (moved > 5 || !outputPage) return

    const { x, y } = normCoords(e)

    if (activeTool === 'text') {
      onAddAnnotation(outputPage.id, { id: uid(), type: 'text', x, y, w: 0.35, text: '', fontSize: 18 })
    }
    if (activeTool === 'signature') {
      onAddAnnotation(outputPage.id, { id: uid(), type: 'signature', x, y, w: 0.3, text: '', fontSize: 52, font: DEFAULT_SIG_FONT, inputMode: true })
    }
  }

  const toggleTool = (tool) => setActiveTool(t => t === tool ? null : tool)

  const drawingStyle = drawingRect ? {
    left: `${Math.min(drawingRect.sx, drawingRect.cx) * 100}%`,
    top: `${Math.min(drawingRect.sy, drawingRect.cy) * 100}%`,
    width: `${Math.abs(drawingRect.cx - drawingRect.sx) * 100}%`,
    height: `${Math.abs(drawingRect.cy - drawingRect.sy) * 100}%`,
  } : null

  const handleAdd = () => {
    if (!currentPage || currentIsAdded) return
    addPage(pdf, currentPage)
  }

  const toolMeta = {
    redact: { label: 'Redact', Icon: RedactIcon, hint: 'Drag a box to permanently remove what is beneath it.' },
    text: { label: 'Text', Icon: TextIcon, hint: 'Click the page to drop a text box, then type.' },
    signature: { label: 'Signature', Icon: SignatureIcon, hint: 'Click to place your signature, then type your name.' },
  }
  const toolCount = (tool) =>
    tool === 'redact' ? redactions.length : annotations.filter(a => a.type === tool).length

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={e => e.stopPropagation()}>

        <div className="preview-header">
          <span className="preview-filename" title={pdf?.name}>{pdf?.name}</span>
          <span className="preview-page-info">Page {currentIndex + 1} of {totalPages}</span>
          <button className="preview-close" onClick={onClose} title="Close (Esc)"><CloseIcon /></button>
        </div>

        {/* App-style tool ribbon */}
        <div className="preview-toolbar">
          <div className="ptb-group">
            {currentIsAdded ? (
              <span className="ptb-intray" title="This page is in your export tray">✓ In tray</span>
            ) : (
              <button className="ptb-add" onClick={handleAdd}>+ Add to tray</button>
            )}
          </div>

          <div className="ptb-divider" />

          <div className="ptb-group ptb-tools">
            {['redact', 'text', 'signature'].map(tool => {
              const { label, Icon, hint } = toolMeta[tool]
              const count = toolCount(tool)
              return (
                <button
                  key={tool}
                  className={`ptb-tool${activeTool === tool ? ' is-active' : ''}`}
                  onClick={() => toggleTool(tool)}
                  disabled={!currentIsAdded}
                  title={currentIsAdded ? hint : 'Add this page to the tray to annotate it'}
                >
                  <Icon />
                  <span className="ptb-tool-label">{label}</span>
                  {count > 0 && <span className="ptb-badge">{count}</span>}
                </button>
              )
            })}
          </div>

          <div className="ptb-divider" />

          <div className="ptb-group">
            {[
              { delta: -90, label: 'Rotate left', ccw: true },
              { delta: 90, label: 'Rotate right', ccw: false },
            ].map(({ delta, label, ccw }) => (
              <button
                key={delta}
                className="ptb-tool ptb-icon-only"
                onClick={() => onRotate(outputPage.id, delta)}
                disabled={!currentIsAdded}
                title={currentIsAdded ? `${label} 90°` : 'Add this page to the tray to rotate it'}
              >
                <RotateIcon ccw={ccw} />
              </button>
            ))}
            {rotation > 0 && <span className="ptb-rotation">{rotation}°</span>}
          </div>

          <div className="ptb-hint">{activeTool ? toolMeta[activeTool].hint : ''}</div>
        </div>

        <div className="preview-body">
          {currentIndex > 0 && (
            <button className="preview-nav prev" onClick={() => setCurrentIndex(i => i - 1)}>‹</button>
          )}
          <div className="preview-image-wrap">
            {loading && <div className="preview-spinner"><div className="spinner" /></div>}
            {previewUrl && (
              <div className="preview-image-container">
                <img src={previewUrl} className="preview-image" alt={`Page ${currentIndex + 1}`} />

                {/* Unified annotation + redaction overlay */}
                <div
                  ref={overlayRef}
                  className={`annotation-layer${activeTool ? ` tool-${activeTool}` : ''}`}
                  onPointerDown={onOverlayPointerDown}
                  onPointerMove={onOverlayPointerMove}
                  onPointerUp={onOverlayPointerUp}
                >
                  {/* Redaction boxes */}
                  {redactions.map((r, i) => (
                    <div key={i} className="redaction-box"
                      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                    >
                      {activeTool === 'redact' && outputPage && (
                        <button className="redaction-remove"
                          onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}
                          onClick={e => { e.stopPropagation(); onRemoveRedaction(outputPage.id, i) }}
                        >×</button>
                      )}
                    </div>
                  ))}
                  {drawingStyle && <div className="redaction-box is-drawing" style={drawingStyle} />}

                  {/* Annotations */}
                  {annotations.map(a => a.type === 'text' ? (
                    <TextAnnotation
                      key={a.id} annotation={a}
                      overlayRef={overlayRef} containerWidth={containerWidth}
                      onUpdate={(id, patch) => onUpdateAnnotation(outputPage.id, id, patch)}
                      onRemove={id => onRemoveAnnotation(outputPage.id, id)}
                    />
                  ) : (
                    <SignatureAnnotation
                      key={a.id} annotation={a}
                      overlayRef={overlayRef} containerWidth={containerWidth}
                      onUpdate={(id, patch) => onUpdateAnnotation(outputPage.id, id, patch)}
                      onRemove={id => onRemoveAnnotation(outputPage.id, id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          {currentIndex < totalPages - 1 && (
            <button className="preview-nav next" onClick={() => setCurrentIndex(i => i + 1)}>›</button>
          )}
        </div>

      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [sourcePdfs, setSourcePdfs] = useState([])
  const [outputPages, setOutputPages] = useState([])
  const [filename, setFilename] = useState('assembled')
  const [loadingNames, setLoadingNames] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [activeDragId, setActiveDragId] = useState(null)
  const [activeDragData, setActiveDragData] = useState(null)
  const [collapsedPdfs, setCollapsedPdfs] = useState(new Set())
  const [previewItem, setPreviewItem] = useState(null)
  const fileInputRef = useRef(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const addedSet = new Set(outputPages.map(p => p.sourcePageId))

  const loadPdfs = useCallback(async (files) => {
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf')
    if (!pdfs.length) return
    setLoadingNames(pdfs.map(f => f.name))
    for (const file of pdfs) {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const pdfId = uid()
      setSourcePdfs(prev => [...prev, { id: pdfId, name: file.name, bytes, pages: [] }])
      try {
        const pdfDoc = await getDocument({ data: bytes.buffer.slice(0), wasmUrl }).promise
        for (let i = 0; i < pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i + 1)
          let thumbUrl = ''
          try { thumbUrl = await renderThumb(page) } catch (err) { console.warn(`Page ${i + 1} render failed:`, err) }
          setSourcePdfs(prev => prev.map(p =>
            p.id === pdfId ? { ...p, pages: [...p.pages, { id: uid(), pageIndex: i, thumbUrl }] } : p
          ))
        }
      } catch (err) { console.error('Failed to load:', file.name, err) }
    }
    setLoadingNames([])
  }, [])

  const handleDrop = useCallback((e) => { e.preventDefault(); setDragOver(false); loadPdfs(e.dataTransfer.files) }, [loadPdfs])
  const handleFileInput = (e) => { loadPdfs(e.target.files); e.target.value = '' }

  const addPage = (pdf, page) => {
    const sourcePageId = `${pdf.id}::${page.pageIndex}`
    if (addedSet.has(sourcePageId)) return
    setOutputPages(prev => [...prev, {
      id: uid(), sourcePageId, sourceId: pdf.id,
      pageIndex: page.pageIndex, sourceName: pdf.name.replace(/\.pdf$/i, ''),
      thumbUrl: page.thumbUrl, rotation: 0, redactions: [], annotations: [],
    }])
  }

  const removePage = (id) => setOutputPages(prev => prev.filter(p => p.id !== id))

  /**
   * Turn one tray page by a quarter, carrying its marks around with it. Doing
   * this here rather than only at export means the preview and the exported
   * file are driven by the same single rotation value.
   */
  const rotatePage = (pageId, delta) =>
    setOutputPages(prev => prev.map(p => p.id !== pageId ? p : {
      ...p,
      rotation: normalizeRotation((p.rotation || 0) + delta),
      redactions: p.redactions.map(r => rotateFractionalRect(r, delta)),
      annotations: p.annotations.map(a => {
        const { x, y } = rotateFractionalRect({ x: a.x, y: a.y, w: a.w || 0, h: 0 }, delta)
        return { ...a, x, y }
      }),
    }))

  const toggleCollapse = (pdfId) => {
    setCollapsedPdfs(prev => { const n = new Set(prev); n.has(pdfId) ? n.delete(pdfId) : n.add(pdfId); return n })
  }

  // Redaction management
  const addRedaction = (pageId, rect) =>
    setOutputPages(prev => prev.map(p => p.id === pageId ? { ...p, redactions: [...p.redactions, rect] } : p))
  const removeRedaction = (pageId, index) =>
    setOutputPages(prev => prev.map(p => p.id === pageId ? { ...p, redactions: p.redactions.filter((_, i) => i !== index) } : p))

  // Annotation management
  const addAnnotation = (pageId, annotation) =>
    setOutputPages(prev => prev.map(p => p.id === pageId ? { ...p, annotations: [...p.annotations, annotation] } : p))
  const updateAnnotation = (pageId, annotId, patch) =>
    setOutputPages(prev => prev.map(p =>
      p.id === pageId ? { ...p, annotations: p.annotations.map(a => a.id === annotId ? { ...a, ...patch } : a) } : p
    ))
  const removeAnnotation = (pageId, annotId) =>
    setOutputPages(prev => prev.map(p =>
      p.id === pageId ? { ...p, annotations: p.annotations.filter(a => a.id !== annotId) } : p
    ))

  const handleDragStart = ({ active }) => { setActiveDragId(active.id); setActiveDragData(active.data.current ?? null) }
  const handleDragEnd = ({ active, over }) => {
    setActiveDragId(null); setActiveDragData(null)
    if (!over) return
    const dragData = active.data.current
    if (dragData?.type === 'source-page') {
      if (over.id === 'output-tray' || outputPages.some(p => p.id === over.id)) addPage(dragData.pdf, dragData.page)
      return
    }
    if (active.id === over.id) return
    setOutputPages(prev => {
      const from = prev.findIndex(p => p.id === active.id)
      const to = prev.findIndex(p => p.id === over.id)
      return arrayMove(prev, from, to)
    })
  }

  const activeOutputPage = activeDragId && activeDragData?.type !== 'source-page' ? outputPages.find(p => p.id === activeDragId) : null
  const activeSourceDrag = activeDragData?.type === 'source-page' ? activeDragData : null
  const isLoading = loadingNames.length > 0

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-brand">
          <img src={`${import.meta.env.BASE_URL}logo-ful.png`} alt="SupportWorks Housing" className="swh-logo" />
          <div className="brand-divider" />
          <span className="brand-name">Dossier</span>
        </div>
        <div className="header-right">
          <div className="filename-wrap">
            <input className="filename-input" value={filename} onChange={e => setFilename(e.target.value)} placeholder="assembled" spellCheck={false} />
            <span className="filename-ext">.pdf</span>
          </div>
          <button className="btn-export" onClick={exportPdf} disabled={outputPages.length === 0}>
            Export{outputPages.length > 0 ? ` (${outputPages.length} pages)` : ' PDF'}
          </button>
        </div>
      </header>

      <DndContext sensors={sensors} collisionDetection={closestCenter}
        onDragStart={handleDragStart} onDragEnd={handleDragEnd}
        onDragCancel={() => { setActiveDragId(null); setActiveDragData(null) }}
      >
        <div className="app-body">
          {/* ── SOURCE PANEL ── */}
          <div className="panel source-panel">
            <div className="panel-bar">
              <h2 className="panel-heading">Source PDFs</h2>
              {isLoading && <span className="loading-badge"><span className="spinner-inline" />Rendering…</span>}
              <button className="btn-add" onClick={() => fileInputRef.current?.click()}>+ Add PDFs</button>
              <input ref={fileInputRef} type="file" accept=".pdf" multiple hidden onChange={handleFileInput} />
            </div>
            <div
              className={`source-scroll${dragOver ? ' drag-over' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
              onDrop={handleDrop}
            >
              {sourcePdfs.length === 0 && !isLoading && (
                <div className="drop-prompt">
                  <svg className="drop-svg" viewBox="0 0 48 56" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="4" y="2" width="30" height="40" rx="3" />
                    <path d="M28 2v12h6" strokeLinejoin="round" />
                    <path d="M11 26h18M11 32h12" strokeLinecap="round" />
                    <path d="M24 50V42M19 46l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <p className="drop-label">Drop PDFs here</p>
                  <p className="drop-hint">or click + Add PDFs above</p>
                </div>
              )}
              {isLoading && sourcePdfs.length === 0 && (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>{loadingNames.length === 1 ? `Loading ${loadingNames[0]}…` : `Loading ${loadingNames.length} files…`}</p>
                </div>
              )}
              {sourcePdfs.map(pdf => {
                const collapsed = collapsedPdfs.has(pdf.id)
                const addedCount = pdf.pages.filter(p => addedSet.has(`${pdf.id}::${p.pageIndex}`)).length
                return (
                  <div key={pdf.id} className={`source-file${collapsed ? ' is-collapsed' : ''}`}>
                    <button className="source-file-label" onClick={() => toggleCollapse(pdf.id)} title={collapsed ? 'Expand' : 'Collapse'}>
                      <svg className="file-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M2 3.5L5 6.5L8 3.5" />
                      </svg>
                      <svg width="13" height="15" viewBox="0 0 13 15" fill="none" stroke="currentColor" strokeWidth="1.4">
                        <rect x="1" y="1" width="9" height="13" rx="1.5" />
                        <path d="M8 1v4h3" strokeLinejoin="round" />
                      </svg>
                      <span title={pdf.name}>{pdf.name}</span>
                      <span className="file-page-count">{addedCount > 0 ? `${addedCount}/` : ''}{pdf.pages.length}p</span>
                    </button>
                    {!collapsed && (
                      <div className="source-pages">
                        {pdf.pages.map(page => {
                          const isAdded = addedSet.has(`${pdf.id}::${page.pageIndex}`)
                          return (
                            <DraggableSourceThumb key={page.id} pdf={pdf} page={page} isAdded={isAdded}
                              onClick={() => setPreviewItem({ pdfId: pdf.id, pageIndex: page.pageIndex })}
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── OUTPUT PANEL ── */}
          <div className="panel output-panel">
            <div className="panel-bar">
              <h2 className="panel-heading">Output Tray</h2>
              {outputPages.length > 0 && (
                <><span className="tray-count">{outputPages.length} page{outputPages.length !== 1 ? 's' : ''}</span>
                <button className="btn-clear" onClick={() => setOutputPages([])}>Clear all</button></>
              )}
            </div>
            <SortableContext items={outputPages.map(p => p.id)} strategy={verticalListSortingStrategy}>
              <OutputDropZone hasCards={outputPages.length > 0}>
                {outputPages.length === 0 && (
                  <div className="output-empty">
                    <svg className="output-empty-svg" viewBox="0 0 48 56" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <rect x="4" y="2" width="30" height="40" rx="3" strokeDasharray="4 3" />
                      <path d="M24 42v10M19 48l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <p>Click a thumbnail to preview it,</p>
                    <p>or drag it here to add.</p>
                    <p className="output-empty-hint">Drag cards to reorder before exporting.</p>
                  </div>
                )}
                {outputPages.map(page => (
                  <SortablePage key={page.id} page={page} onRemove={removePage} onRotate={rotatePage}
                    onPreview={(pdfId, pageIndex) => setPreviewItem({ pdfId, pageIndex })}
                  />
                ))}
              </OutputDropZone>
            </SortableContext>
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeSourceDrag && (
            <div className="source-thumb-overlay">
              {activeSourceDrag.page.thumbUrl ? <img src={activeSourceDrag.page.thumbUrl} alt="" /> : <span className="thumb-err">?</span>}
            </div>
          )}
          {activeOutputPage && (
            <div className="output-card overlay-card">
              <div className="output-card-grip"><GripIcon /></div>
              <div className="output-card-thumb-wrap">
                <img src={activeOutputPage.thumbUrl} className="output-card-thumb" alt=""
                  style={{ transform: `rotate(${normalizeRotation(activeOutputPage.rotation || 0)}deg)` }}
                />
              </div>
              <div className="output-card-meta">
                <span className="output-card-file">{activeOutputPage.sourceName}</span>
                <span className="output-card-page">p. {activeOutputPage.pageIndex + 1}</span>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {previewItem && (
        <PagePreview
          key={`${previewItem.pdfId}-${previewItem.pageIndex}`}
          item={previewItem}
          sourcePdfs={sourcePdfs}
          outputPages={outputPages}
          addPage={addPage}
          onRotate={rotatePage}
          onAddRedaction={addRedaction}
          onRemoveRedaction={removeRedaction}
          onAddAnnotation={addAnnotation}
          onUpdateAnnotation={updateAnnotation}
          onRemoveAnnotation={removeAnnotation}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  )

  // ─── Export — burns all markings permanently into rasterized pages ──────────
  async function exportPdf() {
    if (!outputPages.length) return
    const out = await PDFDocument.create()
    const pdfLibCache = {}
    const pdfJsCache = {}

    for (const op of outputPages) {
      const src = sourcePdfs.find(p => p.id === op.sourceId)
      if (!src) continue

      const needsRaster = (op.redactions?.length > 0) || (op.annotations?.length > 0)
      const rotation = normalizeRotation(op.rotation || 0)

      if (needsRaster) {
        // Ensure signature fonts are loaded before we start drawing
        if (op.annotations?.some(a => a.type === 'signature')) await ensureSignatureFonts()

        if (!pdfJsCache[op.sourceId]) {
          const buf = src.bytes.buffer.slice(src.bytes.byteOffset, src.bytes.byteOffset + src.bytes.byteLength)
          pdfJsCache[op.sourceId] = await getDocument({ data: buf, wasmUrl }).promise
        }
        const pdfJsDoc = pdfJsCache[op.sourceId]
        const page = await pdfJsDoc.getPage(op.pageIndex + 1)

        // Rendering rotated (rather than rotating the finished canvas) means the
        // marks land using the very coordinates the preview captured them in.
        const scale = 2
        const absRotation = page.rotate + rotation
        const renderVp = page.getViewport({ scale, rotation: absRotation })
        const nativeVp = page.getViewport({ scale: 1, rotation: absRotation })

        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(renderVp.width)
        canvas.height = Math.ceil(renderVp.height)
        await page.render({ canvas, viewport: renderVp }).promise

        const ctx = canvas.getContext('2d')

        // 1. Burn redactions
        ctx.fillStyle = '#000000'
        for (const r of (op.redactions || [])) {
          ctx.fillRect(r.x * renderVp.width, r.y * renderVp.height, r.w * renderVp.width, r.h * renderVp.height)
        }

        // 2. Draw text annotations — same font/line-height/top-baseline as the
        //    on-screen box (padding 0) so wrap points and position match exactly.
        const fontScale = renderVp.width / PREVIEW_WIDTH
        for (const a of (op.annotations || [])) {
          if (a.type !== 'text' || !a.text.trim()) continue
          const fs = a.fontSize * fontScale
          const lh = fs * ANNOT_LINE_RATIO
          ctx.font = `${fs}px ${ANNOT_FONT}`
          ctx.fillStyle = '#1A1A1A'
          const maxW = a.w * renderVp.width
          const px = a.x * renderVp.width
          const top = a.y * renderVp.height
          canvasDrawText(ctx, a.text, px, top, maxW, fs, lh)
        }

        // 3. Draw signature annotations in the chosen script font
        for (const a of (op.annotations || [])) {
          if (a.type !== 'signature' || !a.text.trim() || a.inputMode) continue
          const fs = a.fontSize * fontScale
          ctx.font = `${fs}px ${a.font || DEFAULT_SIG_FONT}`
          ctx.fillStyle = '#1A1A2E'
          ctx.textBaseline = 'top'
          ctx.fillText(a.text, a.x * renderVp.width, a.y * renderVp.height)
        }

        const pngBytes = dataUrlToBytes(canvas.toDataURL('image/png'))
        canvas.width = 0
        canvas.height = 0

        const pngImage = await out.embedPng(pngBytes)
        const newPage = out.addPage([nativeVp.width, nativeVp.height])
        newPage.drawImage(pngImage, { x: 0, y: 0, width: nativeVp.width, height: nativeVp.height })
      } else {
        // Clean page — copy as vectors, preserving text and quality
        if (!pdfLibCache[op.sourceId]) {
          pdfLibCache[op.sourceId] = await PDFDocument.load(src.bytes)
        }
        const [copied] = await out.copyPages(pdfLibCache[op.sourceId], [op.pageIndex])
        // Set /Rotate rather than re-drawing, so the page stays vector and its
        // text stays selectable. Additive, to keep the page's original rotation.
        if (rotation) copied.setRotation(degrees(copied.getRotation().angle + rotation))
        out.addPage(copied)
      }
    }

    const pdfBytes = await out.save()
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename || 'assembled'}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }
}
