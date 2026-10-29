// Browser half of dsh-quick-restart: one small "restart" pill in the Windows caption
// strip, immediately left of the native minimize/maximize/close buttons.
//
// Hand-written in the shape dsh's client loader expects: a closure handed to
// window.__ModuleLoader__ whose `require` answers only the shared modules. It must never
// throw — a failing client plugin blanks the whole Web UI — so every step is guarded and
// a failure just means "no button", not "no page".
//
// Geometry: the desktop shell enables titleBarOverlay (a native caption overlay, 40px),
// so the three window buttons are drawn by Windows on top of the page and cannot be
// extended. `navigator.windowControlsOverlay.getTitlebarAreaRect()` reports the area the
// page still owns, i.e. everything left of them; placing the pill 8px left of that edge
// keeps it adjacent to the close button at any window width, scale factor or DPI.
window.__ModuleLoader__.load({
  id: 'dsh-quick-restart',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** Must match ROUTE in index.js. Relative: same origin as the page. */
    const ENDPOINT = '/dsh-quick-restart'
    /** Height of the pill, in CSS px. */
    const PILL_HEIGHT = 28
    /** Gap between the pill and the native caption buttons. */
    const CAPTION_GAP = 8
    /** Fallback caption width when the Window Controls Overlay API is unavailable. */
    const FALLBACK_CAPTION_WIDTH = 152
    /** Fallback caption height (the desktop shell's titleBarOverlay height). */
    const FALLBACK_CAPTION_HEIGHT = 40
    /** How long a request may stay unanswered before the pill reports a problem. */
    const ANSWER_TIMEOUT_MS = 4000

    /**
     * Caption geometry reported by Electron, or safe defaults.
     * @returns {{ right: number, height: number }}
     */
    function readCaption() {
      try {
        const overlay = navigator.windowControlsOverlay
        if (overlay && overlay.visible && typeof overlay.getTitlebarAreaRect === 'function') {
          const rect = overlay.getTitlebarAreaRect()
          if (rect && Number.isFinite(rect.width) && rect.width > 0) {
            // Everything to the right of the page-owned area is native caption buttons.
            const captionWidth = Math.max(0, window.innerWidth - (rect.x + rect.width))
            const height = rect.height > 0 ? rect.height : FALLBACK_CAPTION_HEIGHT
            if (captionWidth >= 60) return { right: captionWidth + CAPTION_GAP, height }
          }
        }
      } catch {
        /* fall through to the defaults */
      }
      return { right: FALLBACK_CAPTION_WIDTH, height: FALLBACK_CAPTION_HEIGHT }
    }

    /** Circular-arrow glyph; inherits `currentColor` so it follows the theme. */
    function RestartGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M8 2.25a5.75 5.75 0 1 0 5.47 7.53',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M8 2.25c1.62 0 3.09.67 4.15 1.75M13.3 1.2v3.4h-3.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    const CSS = `
      .dsh-restart-seat { pointer-events: none; z-index: 45; }
      .dsh-restart-btn {
        pointer-events: auto;
        display: inline-flex; align-items: center; gap: 6px;
        height: ${PILL_HEIGHT}px; padding: 0 10px;
        font: inherit; font-size: 12px; line-height: 1;
        color: inherit; opacity: .72;
        background: transparent;
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        border-radius: 8px;
        cursor: pointer;
        -webkit-app-region: no-drag;
        transition: opacity .15s ease, background-color .15s ease;
      }
      .dsh-restart-btn:hover { opacity: 1; background: color-mix(in srgb, currentColor 9%, transparent); }
      .dsh-restart-btn:active { background: color-mix(in srgb, currentColor 16%, transparent); }
      .dsh-restart-btn:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 55%, transparent); outline-offset: 2px; }
      .dsh-restart-btn[disabled] { cursor: default; opacity: .45; }
      .dsh-restart-btn[data-state="sending"] svg { animation: dsh-restart-spin .9s linear infinite; }
      .dsh-restart-btn[data-state="failed"] { opacity: .9; border-color: color-mix(in srgb, currentColor 45%, transparent); }
      @keyframes dsh-restart-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .dsh-restart-btn[data-state="sending"] svg { animation: none; } }
    `

    function RestartSeat() {
      const [box, setBox] = React.useState(readCaption)
      const [phase, setPhase] = React.useState('idle')
      const [detail, setDetail] = React.useState('')

      React.useEffect(() => {
        const sync = () => setBox(readCaption())
        sync()
        window.addEventListener('resize', sync)
        const overlay = navigator.windowControlsOverlay
        if (overlay && typeof overlay.addEventListener === 'function') {
          overlay.addEventListener('geometrychange', sync)
        }
        return () => {
          window.removeEventListener('resize', sync)
          if (overlay && typeof overlay.removeEventListener === 'function') {
            overlay.removeEventListener('geometrychange', sync)
          }
        }
      }, [])

      const fire = React.useCallback(() => {
        if (phase === 'sending') return
        setPhase('sending')
        setDetail('')
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          // The host answered nothing but the app is probably already going down.
          setPhase('failed')
          setDetail('宿主没有回应，请查看日志')
        }, ANSWER_TIMEOUT_MS)
        const finish = (ok, message) => {
          settled = true
          clearTimeout(timer)
          if (ok) {
            // The app should be gone in a couple of seconds. If it is still here after
            // twelve, the restart failed silently — give the button back.
            setTimeout(() => setPhase('idle'), 12000)
            return
          }
          setPhase('failed')
          setDetail(message)
        }
        try {
          fetch(ENDPOINT, { method: 'POST', cache: 'no-store', credentials: 'same-origin' })
            .then((response) => response.json().catch(() => ({})).then((body) => ({ response, body })))
            .then(({ response, body }) => {
              const ok = response.ok && body && body.ok === true
              finish(ok, (body && body.error) || `宿主拒绝（HTTP ${response.status}）`)
            })
            .catch((error) => finish(false, String((error && error.message) || error)))
        } catch (error) {
          finish(false, String((error && error.message) || error))
        }
      }, [phase])

      const sending = phase === 'sending'
      const label = sending ? '重启中' : phase === 'failed' ? '重试' : '重启'
      const title = detail
        ? `重启 DSH 桌面端失败：${detail}`
        : '重启 DSH 桌面端（关闭所有进程后重新打开）'

      return h(
        'div',
        {
          className: 'dsh-restart-seat',
          style: {
            position: 'fixed',
            top: `${Math.max(0, Math.round((box.height - PILL_HEIGHT) / 2))}px`,
            right: `${box.right}px`,
          },
        },
        h('style', { key: 'dsh-restart-style' }, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-restart-btn',
            'data-state': phase,
            title,
            'aria-label': title,
            disabled: sending,
            onClick: fire,
          },
          h(RestartGlyph),
          h('span', null, label),
        ),
      )
    }

    module.exports.name = 'quick-restart-client'
    module.exports.inject = ['slots']
    module.exports.apply = function apply(ctx) {
      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'quick-restart', order: 10, label: '重启 DSH' },
            RestartSeat,
          ),
        )
      } catch (error) {
        try {
          console.warn('[quick-restart] button disabled:', error)
        } catch {}
      }
    }
    return module.exports
  },
})
