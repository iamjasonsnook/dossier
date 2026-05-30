import { useState, useCallback, useRef, useEffect } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1]
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function renderThumb(page, displayWidth = 176) {
  const nativeVp = page.getViewport({ scale: 1 })
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

async function renderPreview(pdfBytes, pageIndex) {
  const buf = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)
  const pdfDoc = await getDocument({ data: buf, wasmUrl }).promise
  const page = await pdfDoc.getPage(pageIndex + 1)
  return renderThumb(page, PREVIEW_WIDTH)
}

// Ensure Dancing Script is ready in canvas context before drawing signatures
async function ensureSignatureFont() {
  try { await document.fonts.load('700 48px "Dancing Script"') } catch (_) {}
}

// Word-wrapped text for canvas — returns the final y position after drawing
function canvasDrawText(ctx, text, x, y, maxWidth, lineHeight) {
  let cy = y
  for (const para of text.split('\n')) {
    if (!para.trim()) { cy += lineHeight; continue }
    let line = ''
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, cy)
        line = word
        cy += lineHeight
      } else {
        line = test
      }
    }
    if (line) { ctx.fillText(line, x, cy); cy += lineHeight }
  }
  return cy
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

  const fontSize = Math.round(annotation.fontSize * (containerWidth / PREVIEW_WIDTH))

  return (
    <div
      className="annotation text-annotation"
      style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%`, width: `${annotation.w * 100}%` }}
    >
      <div
        className="annotation-header"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
      >
        <span className="annotation-type-label">Text</span>
        <button
          className="annotation-remove"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove(annotation.id) }}
        >×</button>
      </div>
      <textarea
        ref={textareaRef}
        className="annotation-textarea"
        value={annotation.text}
        style={{ fontSize: `${fontSize}px` }}
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

  useEffect(() => {
    if (annotation.inputMode) inputRef.current?.focus()
  }, [annotation.inputMode])

  const commitSignature = (raw) => {
    const text = raw.trim()
    if (!text) { onRemove(annotation.id); return }
    // Estimate width: signature font is wide; ~0.028 per char is a reasonable heuristic
    const w = Math.min(0.75, Math.max(0.18, text.length * 0.028))
    onUpdate(annotation.id, { text, inputMode: false, w })
  }

  const fontSize = Math.round(annotation.fontSize * (containerWidth / PREVIEW_WIDTH))

  if (annotation.inputMode) {
    return (
      <div
        className="annotation signature-annotation input-mode"
        style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
      >
        <input
          ref={inputRef}
          className="signature-input"
          defaultValue=""
          placeholder="Type name, press Enter"
          onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitSignature(e.target.value) }
            if (e.key === 'Escape') onRemove(annotation.id)
          }}
        />
        <button
          className="annotation-remove"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onRemove(annotation.id) }}
        >×</button>
      </div>
    )
  }

  return (
    <div
      className="annotation signature-annotation"
      style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
    >
      <span className="signature-text" style={{ fontSize: `${fontSize}px` }}>
        {annotation.text}
      </span>
      <button
        className="annotation-remove"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onRemove(annotation.id) }}
      >×</button>
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

function SortablePage({ page, onRemove, onPreview }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id })
  const modCount = (page.redactions?.length || 0) + (page.annotations?.length || 0)
  return (
    <div
      ref={setNodeRef}
      className={`output-card${isDragging ? ' is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="output-card-grip" {...attributes} {...listeners}><GripIcon /></div>
      <img
        src={page.thumbUrl} className="output-card-thumb" alt=""
        onClick={() => onPreview(page.sourceId, page.pageIndex)}
        style={{ cursor: 'zoom-in' }}
      />
      <div className="output-card-meta">
        <span className="output-card-file" title={page.sourceName}>{page.sourceName}</span>
        <span className="output-card-page">
          p. {page.pageIndex + 1}
          {modCount > 0 && <span className="modified-badge">{modCount} marked</span>}
        </span>
      </div>
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

function PagePreview({ item, sourcePdfs, outputPages, addPage, onAddRedaction, onRemoveRedaction, onAddAnnotation, onUpdateAnnotation, onRemoveAnnotation, onClose }) {
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

  // Render high-res preview
  useEffect(() => {
    if (!pdf?.bytes) return
    let cancelled = false
    setLoading(true)
    setPreviewUrl(null)
    renderPreview(pdf.bytes, currentIndex)
      .then(url => { if (!cancelled) { setPreviewUrl(url); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [pdf, currentIndex])

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
      onAddAnnotation(outputPage.id, { id: uid(), type: 'signature', x, y, w: 0.3, text: '', fontSize: 52, inputMode: true })
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

  const toolHint = {
    redact: 'Drag to draw a redaction box. Text beneath is permanently removed on export.',
    text: 'Click anywhere on the page to place a text box.',
    signature: 'Click where you want to sign, then type a name and press Enter.',
  }

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={e => e.stopPropagation()}>

        <div className="preview-header">
          <span className="preview-filename" title={pdf?.name}>{pdf?.name}</span>
          <span className="preview-page-info">Page {currentIndex + 1} of {totalPages}</span>
          <button className="preview-close" onClick={onClose} title="Close (Esc)">×</button>
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

        <div className="preview-footer">
          <button
            className={`btn-add-preview${currentIsAdded ? ' is-added' : ''}`}
            onClick={handleAdd} disabled={currentIsAdded}
          >
            {currentIsAdded ? '✓ In Tray' : '+ Add to Tray'}
          </button>

          {currentIsAdded && outputPage && (
            <div className="preview-tools">
              {['redact', 'text', 'signature'].map(tool => (
                <button
                  key={tool}
                  className={`btn-tool${activeTool === tool ? ' is-active' : ''}`}
                  onClick={() => toggleTool(tool)}
                  title={toolHint[tool]}
                >
                  {{ redact: 'Redact', text: 'Text', signature: 'Signature' }[tool]}
                  {tool === 'redact' && redactions.length > 0 && ` (${redactions.length})`}
                  {tool !== 'redact' && annotations.filter(a => a.type === tool).length > 0 &&
                    ` (${annotations.filter(a => a.type === tool).length})`}
                </button>
              ))}
            </div>
          )}
        </div>

        {activeTool && (
          <div className="tool-hint">{toolHint[activeTool]}</div>
        )}
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
      thumbUrl: page.thumbUrl, redactions: [], annotations: [],
    }])
  }

  const removePage = (id) => setOutputPages(prev => prev.filter(p => p.id !== id))

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
          <img src={`${import.meta.env.BASE_URL}logo-white.svg`} alt="SupportWorks Housing" className="swh-logo" />
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
                  <SortablePage key={page.id} page={page} onRemove={removePage}
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
              <img src={activeOutputPage.thumbUrl} className="output-card-thumb" alt="" />
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

      if (needsRaster) {
        // Ensure signature font is loaded before we start drawing
        if (op.annotations?.some(a => a.type === 'signature')) await ensureSignatureFont()

        if (!pdfJsCache[op.sourceId]) {
          const buf = src.bytes.buffer.slice(src.bytes.byteOffset, src.bytes.byteOffset + src.bytes.byteLength)
          pdfJsCache[op.sourceId] = await getDocument({ data: buf, wasmUrl }).promise
        }
        const pdfJsDoc = pdfJsCache[op.sourceId]
        const page = await pdfJsDoc.getPage(op.pageIndex + 1)

        const scale = 2
        const renderVp = page.getViewport({ scale })
        const nativeVp = page.getViewport({ scale: 1 })

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

        // 2. Draw text annotations
        const fontScale = renderVp.width / PREVIEW_WIDTH
        for (const a of (op.annotations || [])) {
          if (a.type !== 'text' || !a.text.trim()) continue
          const fs = Math.round(a.fontSize * fontScale)
          const lh = Math.round(fs * 1.4)
          ctx.font = `${fs}px Arial, Helvetica, sans-serif`
          ctx.fillStyle = '#000000'
          // Draw a subtle white background behind text for legibility
          const maxW = a.w * renderVp.width
          const px = a.x * renderVp.width
          // Draw text (top of text box + 1 line-height for baseline)
          canvasDrawText(ctx, a.text, px, a.y * renderVp.height + fs, maxW, lh)
        }

        // 3. Draw signature annotations
        for (const a of (op.annotations || [])) {
          if (a.type !== 'signature' || !a.text.trim() || a.inputMode) continue
          const fs = Math.round(a.fontSize * fontScale)
          ctx.font = `700 ${fs}px "Dancing Script", cursive`
          ctx.fillStyle = '#1A1A2E'
          ctx.fillText(a.text, a.x * renderVp.width, a.y * renderVp.height + fs)
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
