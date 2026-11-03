/**
 * Styles for the settings card.
 *
 * A single stylesheet is injected once per page and scoped under `.wtts`.
 * Every colour, border and radius references DSH theme tokens with a safe
 * fallback, so the card follows light/dark themes and older DSH versions keep
 * working. Inline styles in the components only carry layout; interaction
 * states (hover/focus/disabled) live here.
 */

const STYLE_ID = 'dsh-whale-tts-styles'

export const CARD_CSS = `
.wtts {
  --wtts-gap-1: 4px;
  --wtts-gap-2: 8px;
  --wtts-gap-3: 12px;
  --wtts-gap-4: 16px;
  --wtts-gap-5: 24px;
  --wtts-radius-sm: var(--dsw-radius-sm, 6px);
  --wtts-radius-md: var(--dsw-radius-md, 8px);
  --wtts-radius-lg: var(--dsw-radius-lg, 12px);
  --wtts-radius-xl: var(--dsw-radius-xl, 14px);
  --wtts-text: var(--dsw-alias-label-primary, inherit);
  --wtts-text-secondary: var(--dsw-alias-label-secondary, #6b7280);
  --wtts-text-tertiary: var(--dsw-alias-label-tertiary, var(--wtts-text-secondary));
  --wtts-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1, rgba(127,127,127,0.28)));
  --wtts-surface: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04)));
  --wtts-surface-2: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.07));
  --wtts-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10));
  --wtts-active: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.16));
  --wtts-brand: var(--dsw-alias-brand-primary, #4f8cff);
  --wtts-brand-soft: color-mix(in srgb, var(--wtts-brand) 14%, transparent);
  --wtts-success: var(--dsw-alias-state-success-primary, #2e8b57);
  --wtts-warn: var(--dsw-alias-state-warn-primary, #b7791f);
  --wtts-error: var(--dsw-alias-state-error-primary, #d64545);
  --wtts-focus: var(--dsw-focus-ring-color, var(--wtts-brand));
  --wtts-mono: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);

  display: flex;
  flex-direction: column;
  gap: var(--wtts-gap-4);
  color: var(--wtts-text);
  font-size: 13px;
  line-height: 1.5;
  letter-spacing: 0.01em;
}

.wtts :where(button, input, select, textarea) {
  font: inherit;
  color: inherit;
}

/* ---------------------------------------------------------------- hero */

.wtts-hero {
  display: flex;
  align-items: center;
  gap: var(--wtts-gap-3);
  padding: 18px 20px;
  border: 0.5px solid var(--wtts-stroke);
  border-radius: var(--wtts-radius-xl);
  background:
    radial-gradient(120% 160% at 0% 0%, var(--wtts-brand-soft), transparent 58%),
    var(--wtts-surface);
}

.wtts-hero-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  color: var(--wtts-brand);
  background: var(--wtts-brand-soft);
  border: 0.5px solid color-mix(in srgb, var(--wtts-brand) 22%, transparent);
}

.wtts-hero-main {
  min-width: 0;
  flex: 1;
}

.wtts-hero-title {
  display: flex;
  align-items: center;
  gap: var(--wtts-gap-2);
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
}

.wtts-hero-sub {
  margin-top: 2px;
  color: var(--wtts-text-tertiary);
  font-size: 12px;
  line-height: 18px;
  max-width: 68ch;
}

.wtts-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wtts-gap-2);
  flex: none;
}

.wtts-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border: 0.5px solid var(--wtts-stroke);
  border-radius: 999px;
  background: var(--wtts-surface);
  color: var(--wtts-text-secondary);
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
}

.wtts-chip-ok {
  color: var(--wtts-success);
  border-color: color-mix(in srgb, var(--wtts-success) 35%, transparent);
  background: color-mix(in srgb, var(--wtts-success) 10%, transparent);
}

.wtts-chip-warn {
  color: var(--wtts-warn);
  border-color: color-mix(in srgb, var(--wtts-warn) 35%, transparent);
  background: color-mix(in srgb, var(--wtts-warn) 10%, transparent);
}

.wtts-chip-brand {
  color: var(--wtts-brand);
  border-color: color-mix(in srgb, var(--wtts-brand) 35%, transparent);
  background: var(--wtts-brand-soft);
}

/* ---------------------------------------------------------------- tabs */

.wtts-tabs {
  display: flex;
  align-items: stretch;
  gap: var(--wtts-gap-1);
  padding: 0 2px;
  border-bottom: 0.5px solid var(--wtts-stroke);
  overflow-x: auto;
  scrollbar-width: thin;
}

.wtts-tab {
  position: relative;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--wtts-radius-md) var(--wtts-radius-md) 0 0;
  background: transparent;
  color: var(--wtts-text-secondary);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.wtts-tab:hover {
  background: var(--wtts-hover);
  color: var(--wtts-text);
}

.wtts-tab[aria-selected='true'] {
  color: var(--wtts-text);
  font-weight: 500;
}

.wtts-tab[aria-selected='true']::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--wtts-brand);
}

.wtts-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--wtts-focus);
}

/* ------------------------------------------------------------ surfaces */

.wtts-card {
  display: flex;
  flex-direction: column;
  gap: var(--wtts-gap-3);
  padding: 16px 18px;
  border: 0.5px solid var(--wtts-stroke);
  border-radius: var(--wtts-radius-xl);
  background: var(--wtts-surface);
}

.wtts[data-tab='voices'] .wtts-card[data-tab]:not([data-tab='voices']),
.wtts[data-tab='interface'] .wtts-card[data-tab]:not([data-tab='interface']),
.wtts[data-tab='backup'] .wtts-card[data-tab]:not([data-tab='backup']) {
  display: none;
}

.wtts-card-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

.wtts-card-head p {
  margin: 3px 0 0;
  max-width: 68ch;
  color: var(--wtts-text-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.wtts-audio {
  padding: 12px 14px;
  background: var(--wtts-surface-2);
}

/* ---------------------------------------------------------- file dropzone */

.wtts-dropzone {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 240px;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px dashed var(--dsw-alias-border-l2, var(--wtts-stroke));
  border-radius: var(--wtts-radius-lg);
  background: transparent;
  color: var(--wtts-text-secondary);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}

.wtts-dropzone:hover {
  border-color: color-mix(in srgb, var(--wtts-brand) 45%, var(--wtts-stroke));
  background: var(--wtts-surface-2);
}

.wtts-dropzone[data-drag='true'] {
  border-color: var(--wtts-brand);
  background: color-mix(in srgb, var(--wtts-brand) 8%, transparent);
}

.wtts-dropzone:focus-within {
  border-color: var(--wtts-brand);
  box-shadow: 0 0 0 2px var(--wtts-focus);
}

.wtts-dropzone > svg {
  flex: none;
  color: var(--wtts-brand);
}

.wtts-dropzone-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.wtts-dropzone-title {
  color: var(--wtts-text);
  font-size: 13px;
  line-height: 18px;
}

.wtts-dropzone-hint {
  color: var(--wtts-text-tertiary);
  font-size: 12px;
  line-height: 16px;
}

.wtts-dropzone-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
  clip-path: inset(50%);
}

/* ------------------------------------------------------- read-aloud action */

/* Lives in the message action row, outside the card root, so it references the
   global --dsw-* tokens directly and uses doubled classes to outrank the
   card's generic button rules without relying on source order. */
.wtts-read.wtts-read {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.wtts-read.wtts-read:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary, #4b5563);
}

.wtts-read.wtts-read[data-state='preparing'] {
  color: var(--dsw-alias-label-secondary, #4b5563);
}

.wtts-read.wtts-read[data-state='playing'] {
  color: var(--dsw-alias-brand-primary, #4f8cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f8cff) 14%, transparent);
}

.wtts-read.wtts-read[data-state='paused'] {
  color: var(--dsw-alias-label-secondary, #4b5563);
}

.wtts-read.wtts-read[data-state='error'] {
  color: var(--dsw-alias-state-error-primary, #d64545);
}

.wtts-read.wtts-read:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f8cff));
  outline-offset: 2px;
}

.wtts-read-spin {
  width: 13px;
  height: 13px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: wtts-read-spin 0.8s linear infinite;
}

@keyframes wtts-read-spin {
  to { transform: rotate(360deg); }
}

/* -------------------------------------------------------------- controls */

.wtts button {
  box-sizing: border-box;
  height: 32px;
  padding: 0 12px;
  border: 0.5px solid var(--wtts-stroke);
  border-radius: var(--wtts-radius-md);
  background: transparent;
  color: var(--wtts-text);
  font-size: 13px;
  line-height: 30px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, filter 120ms ease;
}

.wtts button:hover:not(:disabled) {
  background: var(--wtts-hover);
  filter: brightness(0.99);
}

.wtts button:active:not(:disabled) {
  background: var(--wtts-active);
}

.wtts button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--wtts-focus);
}

.wtts button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wtts .wtts-btn-primary,
.wtts button.wtts-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--wtts-brand));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}

.wtts .wtts-btn-primary:hover:not(:disabled),
.wtts button.wtts-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--wtts-brand));
  filter: brightness(1.02);
}

.wtts .wtts-btn-danger,
.wtts button.wtts-btn-danger {
  color: var(--wtts-error);
  border-color: color-mix(in srgb, var(--wtts-error) 35%, transparent);
}

.wtts .wtts-btn-danger:hover:not(:disabled),
.wtts button.wtts-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, var(--wtts-error) 10%, transparent));
}

.wtts .wtts-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--wtts-text-secondary);
}

.wtts input:not([type='checkbox']):not([type='radio']):not([type='file']),
.wtts select,
.wtts textarea {
  box-sizing: border-box;
  min-width: 0;
  color: var(--wtts-text);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 0.5px solid var(--dsw-alias-border-l2, var(--wtts-stroke));
  border-radius: var(--wtts-radius-md);
  font-size: 13px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.wtts input:not([type='checkbox']):not([type='radio']):not([type='file']),
.wtts select {
  height: 32px;
  padding: 0 10px;
}

.wtts textarea {
  padding: 8px 10px;
  line-height: 1.55;
  resize: vertical;
}

.wtts input::placeholder,
.wtts textarea::placeholder {
  color: var(--wtts-text-tertiary);
}

.wtts input:hover:not(:disabled),
.wtts select:hover:not(:disabled),
.wtts textarea:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l3, var(--wtts-text-tertiary));
}

.wtts input:focus-visible,
.wtts select:focus-visible,
.wtts textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, var(--wtts-brand));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--wtts-focus) 35%, transparent);
}

.wtts input:disabled,
.wtts select:disabled,
.wtts textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wtts input[type='radio'],
.wtts input[type='checkbox'] {
  accent-color: var(--wtts-brand);
  width: 14px;
  height: 14px;
  margin: 0;
}

.wtts input[type='file'] {
  padding: 6px 10px;
  height: auto;
  font-size: 12px;
  color: var(--wtts-text-secondary);
}

.wtts input[type='file']::file-selector-button {
  height: 26px;
  margin-right: 10px;
  padding: 0 10px;
  border: 0.5px solid var(--wtts-stroke);
  border-radius: var(--wtts-radius-sm);
  background: var(--wtts-surface-2);
  color: var(--wtts-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.wtts audio {
  width: 100%;
  height: 34px;
}

/* --------------------------------------------------------------- lists */

.wtts-profile {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--wtts-gap-2);
  padding: 10px 12px;
  border: 0.5px solid transparent;
  border-radius: var(--wtts-radius-lg);
  background: var(--wtts-surface-2);
  transition: border-color 120ms ease, background-color 120ms ease;
}

.wtts-profile:hover {
  border-color: var(--wtts-stroke);
  background: var(--wtts-surface);
}

.wtts-profile[data-active='true'] {
  border-color: color-mix(in srgb, var(--wtts-brand) 40%, transparent);
  background: color-mix(in srgb, var(--wtts-brand) 7%, var(--wtts-surface));
}

.wtts-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 22px 14px;
  border: 0.5px dashed var(--wtts-stroke);
  border-radius: var(--wtts-radius-lg);
  color: var(--wtts-text-tertiary);
  text-align: center;
  font-size: 12px;
}

.wtts-empty strong {
  color: var(--wtts-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

/* -------------------------------------------------------------- notices */

.wtts-status {
  display: flex;
  align-items: flex-start;
  gap: var(--wtts-gap-2);
  padding: 8px 12px;
  border: 0.5px solid transparent;
  border-radius: var(--wtts-radius-md);
  font-size: 12px;
  line-height: 18px;
}

.wtts-status[data-tone='info'] {
  color: var(--wtts-text-secondary);
  border-color: var(--wtts-stroke);
  background: var(--wtts-surface);
}

.wtts-status[data-tone='success'] {
  color: var(--wtts-success);
  border-color: color-mix(in srgb, var(--wtts-success) 32%, transparent);
  background: color-mix(in srgb, var(--wtts-success) 9%, transparent);
}

.wtts-status[data-tone='error'] {
  color: var(--wtts-error);
  border-color: color-mix(in srgb, var(--wtts-error) 32%, transparent);
  background: color-mix(in srgb, var(--wtts-error) 9%, transparent);
}

.wtts-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 0.5px solid var(--wtts-stroke);
  border-radius: 999px;
  background: var(--wtts-surface);
  color: var(--wtts-text-secondary);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.wtts-tag-brand {
  color: var(--wtts-brand);
  border-color: color-mix(in srgb, var(--wtts-brand) 35%, transparent);
  background: var(--wtts-brand-soft);
}

.wtts-tag-ok {
  color: var(--wtts-success);
  border-color: color-mix(in srgb, var(--wtts-success) 30%, transparent);
  background: color-mix(in srgb, var(--wtts-success) 8%, transparent);
}

/* ------------------------------------------------------------- skeleton */

.wtts-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--wtts-gap-3);
}

.wtts-skel-line {
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--wtts-surface-2) 25%, var(--wtts-hover) 37%, var(--wtts-surface-2) 63%);
  background-size: 400% 100%;
  animation: wtts-shimmer 1.4s ease infinite;
}

.wtts-skel-line:nth-child(2n) {
  width: 72%;
}

.wtts-skel-line:nth-child(3n) {
  width: 45%;
}

@keyframes wtts-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: 0 0; }
}

/* ----------------------------------------------------------- responsive */

@media (max-width: 720px) {
  .wtts-hero {
    flex-wrap: wrap;
    padding: 14px 16px;
  }

  .wtts-hero-main {
    flex-basis: calc(100% - 56px);
  }

  .wtts-chips {
    width: 100%;
  }

  .wtts-card {
    padding: 14px;
  }

  .wtts-label {
    min-width: 84px;
  }

  .wtts-hint {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wtts *,
  .wtts *::before,
  .wtts *::after {
    transition: none !important;
    animation: none !important;
  }
}
`

/**
 * Insert the card stylesheet once; returns a disposer.
 *
 * Safe in non-browser environments (unit tests load the bundle in a VM).
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined' || document.head === null) return () => undefined
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => undefined
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.setAttribute('data-wtts-styles', '')
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}
