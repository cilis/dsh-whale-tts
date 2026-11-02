/**
 * Small presentation-only building blocks for the settings card.
 *
 * They are plain React components with class names from `styles.ts`; none of
 * them touch the RPC layer or carry business state.
 */
import React, { useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** Section header: title plus an optional one-line explanation. */
export function CardHeader({
  title,
  description,
}: {
  readonly title: string
  readonly description?: string
}): ReactNode {
  return (
    <div className="wtts-card-head">
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
    </div>
  )
}

/** Dashed empty state. */
export function EmptyState({
  title,
  hint,
}: {
  readonly title: string
  readonly hint?: string
}): ReactNode {
  return (
    <div className="wtts-empty">
      <strong>{title}</strong>
      {hint === undefined ? null : <span>{hint}</span>}
    </div>
  )
}

/** Inline status banner (info/success/error). */
export function StatusBar({
  tone,
  children,
}: {
  readonly tone: 'info' | 'success' | 'error'
  readonly children: ReactNode
}): ReactNode {
  return (
    <div
      className="wtts-status"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  )
}

/** Pill-shaped tag. */
export function Tag({
  children,
  tone,
}: {
  readonly children: ReactNode
  readonly tone?: 'brand' | 'ok' | 'neutral'
}): ReactNode {
  const className =
    tone === 'brand' ? 'wtts-tag wtts-tag-brand' : tone === 'ok' ? 'wtts-tag wtts-tag-ok' : 'wtts-tag'
  return <span className={className}>{children}</span>
}

export interface TabItem {
  readonly id: string
  readonly label: string
}

/**
 * Tab strip. Keyboard: ArrowLeft/ArrowRight/Home/End move focus and select.
 * Panels are rendered by the parent; visibility is driven by CSS via the root
 * `data-tab` attribute, so switching never unmounts a form.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  readonly items: readonly TabItem[]
  readonly value: string
  readonly onChange: (id: string) => void
  readonly label?: string
}): ReactNode {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const move = (delta: number | 'home' | 'end'): void => {
    const index = items.findIndex((item) => item.id === value)
    const nextIndex =
      delta === 'home'
        ? 0
        : delta === 'end'
          ? items.length - 1
          : (index + delta + items.length) % items.length
    const next = items[nextIndex]
    if (next === undefined) return
    onChange(next.id)
    refs.current[next.id]?.focus()
  }
  return (
    <div className="wtts-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            refs.current[item.id] = node
          }}
          type="button"
          role="tab"
          id={`wtts-tab-${item.id}`}
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          className="wtts-tab"
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              move('home')
            } else if (event.key === 'End') {
              event.preventDefault()
              move('end')
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** Small whale-tail mark used in the hero tile. */
export function WhaleMark(): ReactNode {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 12c3.6 0 5.4-1.7 6.6-3.6C10.9 6.9 11.7 5.5 13 5.5c2.4 0 3.5 2 3.5 3.7 0 1-.3 1.8-.8 2.5h1.8c1.9 0 3.5 1.5 3.5 3.4 0 2-1.6 3.4-3.6 3.4H8.2C5.3 18.5 3 16 3 12Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="14.7" cy="9.4" r="1" fill="currentColor" />
      <path d="M6 19.5c1.4.8 2.8 1.2 4.3 1.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** Upload arrow for file dropzones. */
export function UploadMark(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Click-or-drop file picker with the native input visually hidden.
 * Drag highlight is local state; the file itself is handed to `onFile` and
 * never read here, so the component stays presentation-only.
 */
export function FileDropzone({
  accept,
  disabled,
  title,
  hint,
  onFile,
}: {
  readonly accept: string
  readonly disabled?: boolean
  readonly title: string
  readonly hint: string
  readonly onFile: (file: File) => void
}): ReactNode {
  const [dragOver, setDragOver] = useState(false)
  const pick = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file !== undefined) onFile(file)
  }
  return (
    <label
      className="wtts-dropzone"
      data-drag={dragOver ? 'true' : undefined}
      onDragEnter={(event) => {
        event.preventDefault()
        if (disabled !== true) setDragOver(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        const file = event.dataTransfer.files?.[0]
        if (file !== undefined && disabled !== true) onFile(file)
      }}
    >
      <input
        type="file"
        accept={accept}
        className="wtts-dropzone-input"
        disabled={disabled}
        onChange={pick}
      />
      <UploadMark />
      <span className="wtts-dropzone-text">
        <span className="wtts-dropzone-title">{title}</span>
        <span className="wtts-dropzone-hint">{hint}</span>
      </span>
    </label>
  )
}

/** Inline loading dots (used by buttons when busy). */
export function SpinnerDot({ style }: { readonly style?: CSSProperties }): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        marginRight: 6,
        borderRadius: '50%',
        border: '1.5px solid currentColor',
        borderTopColor: 'transparent',
        animation: 'wtts-shimmer 1s linear infinite',
        ...style,
      }}
    />
  )
}
