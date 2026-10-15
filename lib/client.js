// dsh-prompt-studio, browser half.
//
// This file is a PLAIN hand-written bundle, exactly like the ones DSH ships: no
// build step, no `import`/`export` keywords, no JSX, no TypeScript. The page
// loads it as a script, the module loader below hands it a `require`, and the
// only two modules it may ask for are React and the client UI primitives.
//
// What it contributes:
//   - one rail entry in the left sidebar (`sidebar.panellist`, a list seat), and
//   - the workbench behind that entry (`main`, a keyed seat under the same id).
//
// The workbench talks to its Host half over the routes `lib/routes.js` publishes
// under `/dsh-prompt-studio`. It holds no model credentials and calls no provider
// directly: every model call is a POST that the Host turns into an `llm.stream`
// call. The browser side only ever sees prompts and results.
//
// Layout facts this file depends on (all verified against the shipped client):
//   - `sidebar.panellist` entries carry `id`, `order` and `label`, and render
//     their own icon (there is no icon field).
//   - `main` is keyed by that same id. It is a ROOT-scoped seat, so its `inject`
//     callback is called with `(actions)`, NOT with a session id, and its
//     catalog states that only the reserved `conversation` key receives a
//     Session binding. The session id therefore comes from the standard
//     `useSessions` selector hook the slot renderer hands every root occupant.
//   - Both seats are registered from the innermost `slots.inject` callback, so
//     the rail entry and the panel appear together or not at all.
//
// The session's workspace is resolved on the HOST side from the session id; this
// file only passes the id along and displays the workspace it gets back.

window.__ModuleLoader__.load({
  id: 'dsh-prompt-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    /**
     * Panel identity. The layout pairs one `sidebar.panellist` entry with the
     * `main` entry registered under the same key, so these two must agree; the
     * rail entry's `label` is the visible text, the accessible name and the
     * collapsed tooltip.
     */
    const PANEL_ID = 'dsh-prompt-studio'

    /** Route prefix, kept in step with `ROUTE_PREFIX` in the Host half. */
    const API = '/dsh-prompt-studio'

    /**
     * Selectors for the standard `useSessions` hook the slot renderer binds for
     * every root occupant.
     *
     * `main` is a ROOT-scoped seat: its `inject` callback is called with
     * `(actions)`, never with a session id, and its catalog says that only the
     * reserved `conversation` key receives a Session binding. The active session
     * is therefore read through the standard hook, which the renderer hands the
     * occupant as `props.useSessions`. Both selectors tolerate a host that
     * installs no session catalog at all.
     */
    // The sessions catalog snapshot is `{ ids, byId, phase, projectionsBySession }`.
    // There is no `current` field: the live session is the one the main view
    // retains, and `retainedBy.mainView` is the count that says so. Newest
    // `updatedAt` is the fallback for a host that publishes no retain counts.
    const activeRow = (state) => {
      const byId = state?.byId
      if (byId === undefined || byId === null) return null
      let newest = null
      let newestAt = -1
      for (const id of Object.keys(byId)) {
        const row = byId[id]
        if (row === undefined || row === null) continue
        if ((row.retainedBy?.mainView ?? 0) > 0) return row
        const at = typeof row.updatedAt === 'number' ? row.updatedAt : 0
        if (at > newestAt) {
          newestAt = at
          newest = row
        }
      }
      return newest
    }

    const selectSessionId = (state) => {
      const row = activeRow(state)
      return row !== null && typeof row.id === 'string' && row.id !== '' ? row.id : null
    }

    const selectWorkspace = (state) => {
      const row = activeRow(state)
      return row !== null && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
    }

    /**
     * Stand-in for `props.useSessions` on a stripped host.
     *
     * It is a plain function with no hooks of its own, so the panel may always
     * call its selector unconditionally: React never sees a conditional hook.
     */
    function useNoSessions() {
      return undefined
    }

    /**
     * Stand-in for `props.useWorkspaces` on a stripped host.
     *
     * Same contract as `useNoSessions`: no hooks inside, so the panel can call
     * the hook-shaped prop unconditionally and simply see no workspaces.
     */
    function useNoWorkspaces() {
      return undefined
    }

    /** The workspace rows a snapshot carries, or none when the host is stripped. */
    const workspaceRows = (snapshot) => {
      const items = snapshot?.items
      return Array.isArray(items) ? items : []
    }

    // Theme tokens, read as CSS custom properties so the panel follows the
    // active light/dark theme without importing any stylesheet. Each carries a
    // neutral fallback: an unknown token must not make text invisible.
    const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
    const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, inherit)'
    const LABEL_CAPTION = 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, inherit))'
    const BORDER_L1 = 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18))'
    const BORDER_L2 = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25))'
    // `--dsw-alias-bg-base` is literally `transparent` in this theme: painting a
    // panel with it makes the content float on whatever the shell shows through
    // (a wallpaper, when the wallpaper plugin is installed). Surfaces therefore
    // use the module fill, and controls use the opaque layer fill.
    const BG_PANEL = 'var(--dsw-alias-bg-module-platform, rgba(14, 31, 32, 0.59))'
    const BG_FIELD = 'var(--dsw-alias-bg-layer-1, #232324)'
    const BG_MODULE = 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))'
    const BG_HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1))'
    const ACCENT = 'var(--dsw-alias-state-business-primary, #4f6ef7)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #d14343)'
    const WARN = 'var(--dsw-alias-state-warn-primary, #b45309)'
    const SUCCESS = 'var(--dsw-alias-state-success-primary, #2f9e44)'
    const MONO = 'var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    const MODES = [
      { value: 'user', label: '用户提示词' },
      { value: 'system', label: '系统提示词' },
    ]

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------

    /** The `provider/model` key a route is addressed by in the UI. */
    function routeKey(route) {
      return route === null || route === undefined ? '' : route.provider + '/' + route.model
    }

    // A model id that names a task other than "write text for me". The catalog
    // carries no capability field, so this is the only signal available. It is a
    // *ranking* signal, never a filter: a host whose only model matches one of
    // these words must still be able to pick it. The Host half sorts the same way,
    // but the panel must not depend on that — an older Host may not have sorted,
    // and the selector has to be sensible either way.
    const NON_CHAT_HINT = /embed|rerank|whisper|tts|speech|dall|stable-diffusion|sdxl|flux|midjourney|image-gen|ocr|moderation|audio|vision-encoder/i

    /** Whether a route looks like it is not a chat model. */
    function looksNonChat(route) {
      return NON_CHAT_HINT.test(route.model) || NON_CHAT_HINT.test(route.name)
    }

    /** The first route worth preselecting: a chat-like one if the catalog has any. */
    function preferredRoute(routes) {
      if (routes.length === 0) return ''
      const chat = routes.find((route) => !looksNonChat(route))
      return routeKey(chat === undefined ? routes[0] : chat)
    }

    /** Split a route key back into `{ provider, model }`. */
    function parseRouteKey(key) {
      if (typeof key !== 'string') return null
      const slash = key.indexOf('/')
      if (slash <= 0) return null
      return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
    }

    /** A human duration. */
    function formatMs(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return ms + ' ms'
      return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'
    }

    /** A human timestamp. */
    function formatTime(value) {
      const date = new Date(typeof value === 'number' ? value : Number(value))
      if (isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** The one-line label a version is listed under. */
    function versionTitle(row) {
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : ''
      if (title !== '') return title.length > 40 ? title.slice(0, 40) + '…' : title
      const content = typeof row.content === 'string' ? row.content.replace(/\s+/g, ' ').trim() : ''
      return content === '' ? '（空）' : content.slice(0, 40) + (content.length > 40 ? '…' : '')
    }

    /**
     * A line-level diff between two versions.
     *
     * Line level, not word level: the chain is read at a glance to answer "what
     * changed between v2 and v3", and a word-level highlight inside every line
     * turns that glance into reading. Whole added/removed lines are what the eye
     * can scan.
     *
     * The algorithm is the textbook LCS table. Two guards matter in practice:
     * an empty side short-circuits (no table at all), and a pair large enough to
     * make the table unreasonable degrades to "everything is new" rather than
     * allocating a quadratic array. Prompt text is capped at 20000 characters by
     * the Host, so the table is normally a few hundred cells per side.
     */
    function diffLines(previous, next) {
      // An empty string is "no lines", not "one empty line": splitting it would
      // otherwise report a phantom deletion of a blank line that never existed.
      const before = typeof previous === 'string' && previous !== '' ? previous.split('\n') : []
      const after = typeof next === 'string' && next !== '' ? next.split('\n') : []
      if (before.length === 0) return after.map((text) => ({ kind: 'add', text }))
      if (after.length === 0) return before.map((text) => ({ kind: 'del', text }))
      if (before.length * after.length > 1000000) {
        return after.map((text) => ({ kind: 'add', text }))
      }
      const width = after.length + 1
      const table = new Int32Array((before.length + 1) * width)
      for (let i = before.length - 1; i >= 0; i -= 1) {
        for (let j = after.length - 1; j >= 0; j -= 1) {
          table[i * width + j] = before[i] === after[j]
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
        }
      }
      const lines = []
      let i = 0
      let j = 0
      while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
          lines.push({ kind: 'same', text: after[j] })
          i += 1
          j += 1
        } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
          lines.push({ kind: 'del', text: before[i] })
          i += 1
        } else {
          lines.push({ kind: 'add', text: after[j] })
          j += 1
        }
      }
      while (i < before.length) {
        lines.push({ kind: 'del', text: before[i] })
        i += 1
      }
      while (j < after.length) {
        lines.push({ kind: 'add', text: after[j] })
        j += 1
      }
      return lines
    }

    /** How a diff line is painted: removed red, added green, unchanged plain. */
    function diffLineStyle(kind) {
      if (kind === 'add') {
        return {
          ...DIFF_LINE_BASE,
          background: 'rgba(47, 158, 68, 0.16)',
          borderLeft: '2px solid ' + SUCCESS,
        }
      }
      if (kind === 'del') {
        return {
          ...DIFF_LINE_BASE,
          background: 'rgba(209, 67, 67, 0.14)',
          borderLeft: '2px solid ' + DANGER,
          textDecoration: 'line-through',
          color: LABEL_TERTIARY,
        }
      }
      return { ...DIFF_LINE_BASE, borderLeft: '2px solid transparent' }
    }

    /** The origin of a version, in Chinese. */
    const ORIGIN_LABELS = {
      manual: '手写',
      optimize: '优化',
      iterate: '迭代',
      template: '模板',
    }

    /** What each run kind means, in Chinese. */
    const KIND_LABELS = {
      optimize: '优化',
      iterate: '迭代',
    }

    /**
     * One JSON request to the Host half.
     *
     * A failed request is turned into an Error carrying the Host's own message:
     * the panel shows that text verbatim rather than a generic failure, because
     * "provider "x" 下没有模型 "y"" is actionable and "请求失败" is not.
     */
    async function callApi(path, options) {
      const opts = options === undefined ? {} : options
      const method = opts.method === undefined ? 'GET' : opts.method
      const init = { method }
      if (method !== 'GET') {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(opts.body === undefined ? {} : opts.body)
      }
      const response = await fetch(API + path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (response.ok !== true) {
        const message = payload !== null && typeof payload.error === 'string'
          ? payload.error
          : '请求失败（HTTP ' + response.status + '）'
        throw new Error(message)
      }
      return payload
    }

    // -----------------------------------------------------------------------
    // Icons (drawn here: a panellist seat has no icon field)
    // -----------------------------------------------------------------------

    /** The rail icon: a wand over a line of text — "rewrite this prompt". */
    function StudioIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M9.5 2.5l1.2 2.6 2.6 1.2-2.6 1.2-1.2 2.6-1.2-2.6L5.7 6.3l2.6-1.2z' }),
        h('path', { d: 'M2.5 12.5h6' }),
        h('path', { d: 'M2.5 10h4' }),
      )
    }

    /**
     * The keyframes this bundle's inline styles reference.
     *
     * A browser silently ignores an `animation` whose `@keyframes` is defined
     * nowhere: no error, no warning, the element simply never moves. That is
     * exactly what happened to the spinner — it referenced
     * `dsh-prompt-studio-spin` and nothing ever declared it, so the arc sat
     * still and every long call looked stuck. Both animations live here and are
     * installed once, before the first render.
     */
    const STYLE_ELEMENT_ID = 'dsh-prompt-studio-keyframes'

    function installKeyframes() {
      if (typeof document === 'undefined' || document === null) return
      if (document.getElementById(STYLE_ELEMENT_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ELEMENT_ID
      style.textContent = [
        '@keyframes dsh-prompt-studio-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
        '@keyframes dsh-prompt-studio-slide{0%{left:-38%}100%{left:100%}}',
      ].join('')
      const head = document.head === undefined || document.head === null ? document.body : document.head
      if (head === undefined || head === null) return
      head.appendChild(style)
    }

    /** A tiny spinner. */
    function Spinner(props) {
      const size = props.size === undefined ? 13 : props.size
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        style: {
          animation: 'dsh-prompt-studio-spin 0.9s linear infinite',
          transformOrigin: 'center',
          transformBox: 'view-box',
          flex: '0 0 auto',
        },
      },
        h('circle', {
          cx: 8, cy: 8, r: 6,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeDasharray: '24 14',
          strokeLinecap: 'round',
          opacity: 0.9,
        }),
      )
    }

    /**
     * Whole seconds elapsed since `since`, re-rendered once a second.
     *
     * Returns null while idle. A ticking readout is the honest way to show that
     * a one-shot request is still alive: it is the only number the browser can
     * actually know.
     */
    function useElapsed(since) {
      const [seconds, setSeconds] = useState(
        since === null || since === undefined ? null : 0,
      )
      useEffect(() => {
        if (since === null || since === undefined) {
          setSeconds(null)
          return undefined
        }
        const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)))
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [since])
      return seconds
    }

    /**
     * The busy indicator: an indeterminate bar plus the live wait time.
     *
     * `/optimize` and `/iterate` answer in a single JSON body once the model has
     * finished, so the browser has no fraction to show and a percentage would be
     * a lie. An indeterminate bar says "working" truthfully; the second counter
     * says "still working" instead of leaving the user to guess.
     */
    function ProgressBar(props) {
      const elapsed = useElapsed(props.since)
      return h('div', { style: PROGRESS_WRAP_STYLE, role: 'status', 'aria-live': 'polite' },
        h('div', { style: PROGRESS_TRACK_STYLE },
          h('div', { style: PROGRESS_BAR_STYLE }),
        ),
        h('div', { style: ROW_STYLE },
          h('span', { style: NOTE_STYLE }, props.label),
          h('span', { style: SPACER_STYLE }),
          h('span', { style: NOTE_STYLE }, elapsed === null ? '' : '已等待 ' + elapsed + ' 秒'),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Shared styles
    // -----------------------------------------------------------------------

    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      color: LABEL_PRIMARY,
      background: BG_PANEL,
      fontSize: 13,
      lineHeight: 1.6,
    }

    const HEADER_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 14px',
      borderBottom: '1px solid ' + BORDER_L1,
      flex: '0 0 auto',
    }

    const TITLE_STYLE = { fontSize: 13, fontWeight: 600, margin: 0 }
    const CAPTION_STYLE = { fontSize: 11, color: LABEL_TERTIARY }

    const BODY_STYLE = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      padding: '12px 14px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }

    const CARD_STYLE = {
      border: '1px solid ' + BORDER_L1,
      borderRadius: 6,
      padding: '10px 12px',
      background: BG_MODULE,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }

    const LABEL_STYLE = {
      fontSize: 11,
      fontWeight: 600,
      color: LABEL_SECONDARY,
      letterSpacing: '0.02em',
    }

    const TEXTAREA_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      minHeight: 120,
      resize: 'vertical',
      padding: '8px 10px',
      borderRadius: RADIUS,
      border: '1px solid ' + BORDER_L2,
      background: BG_FIELD,
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: 12.5,
      lineHeight: 1.6,
      outline: 'none',
    }

    const SELECT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: RADIUS,
      border: '1px solid ' + BORDER_L2,
      background: BG_FIELD,
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: 12.5,
    }

    const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const SPACER_STYLE = { flex: '1 1 auto' }

    const NOTE_STYLE = { fontSize: 11.5, color: LABEL_TERTIARY, margin: 0 }

    const ERROR_STYLE = {
      fontSize: 12,
      color: DANGER,
      margin: 0,
      padding: '8px 10px',
      border: '1px solid ' + DANGER,
      borderRadius: RADIUS,
      background: 'transparent',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    const NOTICE_STYLE = {
      fontSize: 12,
      color: LABEL_SECONDARY,
      margin: 0,
      padding: '6px 10px',
      border: '1px solid ' + BORDER_L1,
      borderRadius: RADIUS,
      whiteSpace: 'pre-wrap',
    }

    const CODE_STYLE = {
      fontFamily: MONO,
      fontSize: 11.5,
      color: LABEL_TERTIARY,
      wordBreak: 'break-all',
    }

    /**
     * The busy bar. The track clips, the bar slides — see the keyframes above.
     *
     * `position: relative` + `overflow: hidden` on the track and `position:
     * absolute` on the bar is what keeps the slide inside the rounded box; a
     * bar animated with `left` percentages needs both or it paints outside.
     */
    const PROGRESS_WRAP_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
    }

    const PROGRESS_TRACK_STYLE = {
      position: 'relative',
      overflow: 'hidden',
      height: 3,
      borderRadius: 999,
      background: BORDER_L1,
    }

    const PROGRESS_BAR_STYLE = {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: '38%',
      borderRadius: 999,
      background: ACCENT,
      animation: 'dsh-prompt-studio-slide 1.25s ease-in-out infinite',
    }

    /** The 「在新对话中使用」 target chooser surface, stacked above the result. */
    const PICKER_STYLE = {
      border: '1px solid ' + BORDER_L2,
      borderRadius: RADIUS,
      padding: '9px 10px',
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
      background: BG_MODULE,
      boxSizing: 'border-box',
    }

    const LIST_ITEM_STYLE = {
      border: '1px solid ' + BORDER_L1,
      borderRadius: RADIUS,
      padding: '7px 9px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      cursor: 'pointer',
      background: BG_FIELD,
    }

    const CHIP_STYLE = {      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 11,
      color: LABEL_TERTIARY,
      border: '1px solid ' + BORDER_L1,
      borderRadius: 999,
      padding: '0 7px',
      lineHeight: '18px',
    }

    /** One line of a diffed version: the padding is shared, the paint is not. */
    const DIFF_LINE_BASE = {
      fontFamily: MONO,
      fontSize: 11.5,
      lineHeight: 1.55,
      padding: '0 6px 0 4px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      color: LABEL_SECONDARY,
    }

    /** The horizontal version chain: one column per version, scrolling sideways. */
    const CHAIN_SCROLL_STYLE = {
      display: 'flex',
      flexDirection: 'row',
      gap: 8,
      overflowX: 'auto',
      overflowY: 'hidden',
      alignItems: 'stretch',
      paddingBottom: 2,
    }

    const CHAIN_COLUMN_STYLE = {
      flex: '1 1 0',
      minWidth: 220,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      border: '1px solid ' + BORDER_L1,
      borderRadius: RADIUS,
      background: BG_FIELD,
      padding: '7px 8px',
      boxSizing: 'border-box',
    }

    const CHAIN_BODY_STYLE = {
      maxHeight: 320,
      overflowY: 'auto',
      overflowX: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }

    /** A labelled block: the label above its control. */
    function Field(props) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('span', { style: LABEL_STYLE }, props.label),
        props.children,
      )
    }

    /** The empty state, so a blank area always says what it is waiting for. */
    function Empty(props) {
      return h('p', { style: { ...NOTE_STYLE, padding: '10px 0', textAlign: 'center' } }, props.text)
    }

    /** The error state: the Host's own message, never swallowed. */
    function ErrorBox(props) {
      if (props.error === null || props.error === undefined || props.error === '') return null
      return h('p', { style: ERROR_STYLE, role: 'alert' }, String(props.error))
    }

    // -----------------------------------------------------------------------
    // The model picker
    // -----------------------------------------------------------------------

    /**
     * The route selector.
     *
     * One flat `<select>` over every `provider/model` the Host reported, because
     * that is what the Host can actually call: the panel never offers a
     * combination the catalog does not contain. A catalog that failed to load
     * entirely is reported instead of showing an empty picker.
     */
    function RoutePicker(props) {
      const routes = props.routes
      const options = routes.map((route) => h('option', {
        key: routeKey(route),
        value: routeKey(route),
      }, route.provider + ' / ' + route.name))

      return h(Field, { label: props.label === undefined ? '模型' : props.label },
        h('select', {
          style: SELECT_STYLE,
          value: props.value,
          disabled: props.disabled === true || routes.length === 0,
          onChange: (event) => props.onChange(event.target.value),
        },
          routes.length === 0
            ? h('option', { value: '' }, '没有可用的模型')
            : [h('option', { key: '__none', value: '' }, '（选择模型）')].concat(options),
        ),
        props.failures !== undefined && props.failures.length > 0
          ? h('p', { style: NOTE_STYLE }, '以下 provider 的模型列表读取失败：' +
            props.failures.map((f) => f.provider + '（' + f.message + '）').join('；'))
          : null,
      )
    }

    /**
     * The 「在新对话中使用」 target chooser.
     *
     * It is a list of the workspaces the catalog already knows, plus a row that
     * opens the host's own folder chooser for a directory that is not a
     * workspace yet. Nothing here guesses: the user names the target, and the
     * result text is whatever stands in the result box at that moment.
     */
    function NewChatPicker(props) {
      const rows = props.workspaces
      const busy = props.busy
      return h('div', { style: PICKER_STYLE },
        h('div', { style: ROW_STYLE },
          h('span', { style: LABEL_STYLE }, '在新对话中使用'),
          h('span', { style: SPACER_STYLE }),
          h(primitives.Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: busy,
            onClick: () => props.onClose(),
          }, '取消'),
        ),
        h('p', { style: NOTE_STYLE }, '选择新对话所在的工作区；内容会填入该对话的输入框并直接发送。'),
        rows.length === 0
          ? null
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            rows.map((workspace) => h('div', {
              key: workspace.workspaceId,
              style: { ...LIST_ITEM_STYLE, opacity: busy ? 0.6 : 1 },
              onClick: () => {
                if (busy) return
                props.onPick(workspace)
              },
            },
              h('div', { style: ROW_STYLE },
                h('span', { style: { display: 'inline-flex', color: LABEL_SECONDARY } },
                  h(primitives.IconFolderCloseRegular, { size: 16 })),
                h('span', { style: { ...CAPTION_STYLE, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  workspace.title === '' || workspace.title === undefined ? workspace.path : workspace.title),
              ),
              h('span', { style: CODE_STYLE }, workspace.path),
            )),
          ),
        h('div', { style: ROW_STYLE },
          h(primitives.Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            icon: h(primitives.IconFolderCloseRegular, null),
            onClick: () => props.onBrowse(),
          }, '选择文件夹…'),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // The optimisation pane
    // -----------------------------------------------------------------------

    /**
     * Input, result and version chain — the workbench's main column.
     *
     * The result is an editable textarea rather than a read-only block: the point
     * of the tool is that the user finishes the prompt themselves, and a version
     * they hand-edited must be storable and iterable like one the model wrote.
     */
    function OptimizePane(props) {
      const s = props.state
      const set = props.set

      const canRun = s.busy === null && s.input.trim() !== '' && s.route !== ''
      const canIterate = s.result.trim() !== '' || s.input.trim() !== ''
      const busyHere = s.busy === 'optimize' || s.busy === 'iterate'

      return h(React.Fragment, null,
        h('div', { style: CARD_STYLE },
          h(Field, { label: '原始提示词' },
            h('textarea', {
              style: TEXTAREA_STYLE,
              value: s.input,
              placeholder: '把要优化的提示词粘贴到这里…',
              spellCheck: false,
              onChange: (event) => set({ input: event.target.value }),
            }),
          ),
          h('div', { style: ROW_STYLE },
            h(primitives.SegmentedControl, {
              id: 'dsh-prompt-studio-mode',
              value: s.mode,
              options: MODES,
              label: '提示词类型',
              disabled: busyHere,
              onChange: (value) => set({ mode: value }),
            }),
            h('span', { style: SPACER_STYLE }),
            h('span', { style: CAPTION_STYLE }, s.input.length + ' 字符'),
          ),
          h(RoutePicker, {
            routes: s.routes,
            failures: s.failures,
            value: s.route,
            disabled: busyHere,
            onChange: (value) => props.chooseRoute(value),
          }),
          h('div', { style: ROW_STYLE },
            h(primitives.Button, {
              variant: 'primary',
              disabled: !canRun,
              icon: s.busy === 'optimize' ? h(Spinner, null) : h(primitives.IconSparkleMedium, null),
              onClick: () => props.onOptimize(),
            }, s.busy === 'optimize' ? '正在优化…' : '优化'),
            h(primitives.Button, {
              variant: 'outline',
              disabled: s.busy !== null || !canIterate || s.route === '',
              icon: s.busy === 'iterate' ? h(Spinner, null) : null,
              onClick: () => props.onToggleIterate(),
            }, s.busy === 'iterate' ? '正在迭代…' : s.iterateOpen === true ? '取消迭代' : '迭代'),
            h('span', { style: SPACER_STYLE }),
            s.mode === 'system'
              ? h('span', { style: CHIP_STYLE }, '系统提示词')
              : null,
          ),

          // The iteration direction, inline. A dialog would be a second UI
          // concept for a one-line answer; `window.prompt` is not an option at
          // all — Electron refuses it outright, and the rejection is swallowed
          // by the React event handler, so the button just did nothing.
          s.iterateOpen === true
            ? h('div', { style: PICKER_STYLE },
              h('span', { style: LABEL_STYLE }, '迭代方向'),
              h('p', { style: NOTE_STYLE }, '例如「使提示词更加简洁」「补上输出格式约束」；留空则做通用迭代。'),
              h('div', { style: ROW_STYLE },
                h('input', {
                  style: { ...SELECT_STYLE, flex: '1 1 200px', minWidth: 0 },
                  value: s.iterateDirection,
                  placeholder: '留空则做通用迭代',
                  spellCheck: false,
                  disabled: s.busy !== null,
                  autoFocus: true,
                  onChange: (event) => set({ iterateDirection: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && s.busy === null) {
                      event.preventDefault()
                      props.onIterate()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      props.onCloseIterate()
                    }
                  },
                }),
                h(primitives.Button, {
                  variant: 'primary',
                  size: 'sm',
                  disabled: s.busy !== null || !canIterate,
                  icon: s.busy === 'iterate' ? h(Spinner, null) : null,
                  onClick: () => props.onIterate(),
                }, s.busy === 'iterate' ? '正在迭代…' : '开始迭代'),
              ),
            )
            : null,

          busyHere
            ? h(ProgressBar, {
              since: s.busySince,
              label: s.busy === 'optimize' ? '模型正在改写提示词…' : '模型正在迭代…',
            })
            : null,
        ),

        h(ErrorBox, { error: s.error }),

        s.result !== ''
          ? h('div', { style: CARD_STYLE },
            h('div', { style: ROW_STYLE },
              h('span', { style: LABEL_STYLE }, '优化结果'),
              h('span', { style: SPACER_STYLE }),
              h('span', { style: CAPTION_STYLE },
                s.resultMeta === null
                  ? ''
                  : s.resultMeta.provider + '/' + s.resultMeta.model + ' · ' +
                    formatMs(s.resultMeta.elapsedMs) +
                    (s.resultMeta.stored === false ? ' · 未落库' : '')),
            ),
            h('textarea', {
              style: { ...TEXTAREA_STYLE, minHeight: 160 },
              value: s.result,
              spellCheck: false,
              onChange: (event) => set({ result: event.target.value }),
            }),
            h('div', { style: ROW_STYLE },
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconCopyOutlineMedium, null),
                onClick: () => props.onCopy(s.result),
              }, '复制'),
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconNewChatOutlineMedium, null),
                disabled: s.busy !== null,
                onClick: () => props.onUseInNewChat(s.result),
              }, '在新对话中使用'),
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconPlusOutlineMedium, null),
                disabled: s.busy !== null,
                onClick: () => props.onToggleTemplate(),
              }, s.templateOpen === true ? '取消存模板' : '存为模板'),
              h(primitives.Button, {
                variant: 'ghost',
                icon: h(primitives.IconDatabaseOutlineMedium, null),
                onClick: () => props.onPersist(s.result),
              }, '存入历史'),
            ),

            // The template name, inline. Same reason as the iteration row:
            // `window.prompt` is refused by Electron and the button silently
            // did nothing.
            s.templateOpen === true
              ? h('div', { style: PICKER_STYLE },
                h('span', { style: LABEL_STYLE }, '模板名称'),
                h('div', { style: ROW_STYLE },
                  h('input', {
                    style: { ...SELECT_STYLE, flex: '1 1 160px', minWidth: 0 },
                    value: s.templateName,
                    placeholder: '例如「结构化输出模板」',
                    spellCheck: false,
                    autoFocus: true,
                    onChange: (event) => set({ templateName: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        props.onSaveTemplate(s.result)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        props.onCloseTemplate()
                      }
                    },
                  }),
                  h(primitives.Button, {
                    variant: 'primary',
                    size: 'sm',
                    disabled: s.templateName.trim() === '',
                    onClick: () => props.onSaveTemplate(s.result),
                  }, '保存'),
                ),
              )
              : null,
          )
          : h(Empty, { text: '还没有结果。输入一段提示词，选好模型，点「优化」。' }),

        s.newChatOpen === true
          ? h(NewChatPicker, {
            workspaces: props.workspaces === undefined ? [] : props.workspaces,
            busy: s.busy !== null,
            onPick: (workspace) => props.onUseInNewChatPick(s.result, workspace),
            onBrowse: () => props.onUseInNewChatBrowse(s.result),
            onClose: () => props.onCloseNewChat(),
          })
          : null,

        h(ChainPane, {
          chain: s.chain,
          activeId: s.baseId,
          busy: s.busy !== null,
          onPick: (row) => props.onPickVersion(row),
          onDelete: (row) => props.onDeleteVersion(row),
        }),
      )
    }

    /**
     * The version chain: v1 original, v2 optimised, v3 tighter, …
     *
     * Laid out as columns, one version per column, so the whole chain can be
     * compared side by side instead of one version at a time behind a click.
     * Every column shows its own content in full, and every column after the
     * first is diffed against the one to its left: removed lines are struck
     * through in red, added lines are washed green. v1 has nothing to compare
     * against and is painted plain.
     */
    function ChainPane(props) {
      if (props.chain.length === 0) {
        return h('div', { style: CARD_STYLE },
          h('span', { style: LABEL_STYLE }, '版本链'),
          h(Empty, { text: '还没有版本。优化一次就会产生第一版。' }),
        )
      }
      const columns = props.chain.map((row, index) => {
        const previous = index === 0 ? null : props.chain[index - 1]
        return {
          row,
          index,
          active: row.id === props.activeId,
          lines: previous === null ? null : diffLines(previous.content, row.content),
        }
      })
      return h('div', { style: CARD_STYLE },
        h('div', { style: ROW_STYLE },
          h('span', { style: LABEL_STYLE }, '版本链'),
          h('span', { style: SPACER_STYLE }),
          h('span', { style: CAPTION_STYLE }, '共 ' + props.chain.length + ' 版 · 横向对比'),
          h('span', { style: CAPTION_STYLE }, '相对上一版：'),
          h('span', { style: { ...CAPTION_STYLE, color: SUCCESS } }, '新增'),
          h('span', { style: { ...CAPTION_STYLE, color: DANGER } }, '删除'),
        ),
        h('div', { style: CHAIN_SCROLL_STYLE },
          columns.map((column) => {
            const row = column.row
            const active = column.active
            return h('div', {
              key: row.id,
              style: {
                ...CHAIN_COLUMN_STYLE,
                borderColor: active ? ACCENT : BORDER_L1,
                opacity: props.busy ? 0.6 : 1,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 11, fontWeight: 600, color: active ? ACCENT : LABEL_SECONDARY } },
                  'v' + (column.index + 1)),
                h('span', { style: CHIP_STYLE }, ORIGIN_LABELS[row.origin] === undefined ? row.origin : ORIGIN_LABELS[row.origin]),
                h('span', { style: { ...CAPTION_STYLE, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  formatTime(row.created_at)),
              ),
              h('div', { style: { ...CAPTION_STYLE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                versionTitle(row)),
              h('div', { style: CHAIN_BODY_STYLE },
                column.lines === null
                  ? h('pre', { style: { ...DIFF_LINE_BASE, margin: 0, color: LABEL_SECONDARY } }, row.content)
                  : column.lines.map((line, lineIndex) => h('div', {
                    key: lineIndex,
                    style: diffLineStyle(line.kind),
                  }, line.text === '' ? '\u00a0' : line.text)),
              ),
              h('div', { style: ROW_STYLE },
                h(primitives.Button, {
                  variant: 'ghost',
                  size: 'sm',
                  onClick: () => props.onPick(row),
                }, active ? '已载入' : '载入这一版'),
                h('span', { style: SPACER_STYLE }),
                h(primitives.Button, {
                  variant: 'ghost',
                  size: 'sm',
                  icon: h(primitives.IconTrashOutlineMedium, null),
                  onClick: () => props.onDelete(row),
                }, '删除'),
              ),
            )
          }),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // The templates and history pane
    // -----------------------------------------------------------------------

    /**
     * Templates and history.
     *
     * Templates are the SYSTEM prompts handed to the optimiser, not prompts for
     * the user's own task, so picking one only changes how the next optimisation
     * is instructed. History is the stored record of every run, filterable by
     * mode and model, and deletable.
     */
    function LibraryPane(props) {
      const s = props.state
      const set = props.set
      const [modeFilter, setModeFilter] = useState('')
      const [providerFilter, setProviderFilter] = useState('')
      const [busy, setBusy] = useState(false)

      const providers = useMemo(() => {
        const seen = []
        for (const run of s.history.runs) {
          if (seen.indexOf(run.provider) < 0) seen.push(run.provider)
        }
        return seen
      }, [s.history.runs])

      const reload = async (nextMode, nextProvider) => {
        setBusy(true)
        try {
          const query = []
          if (props.sessionId) query.push('sessionId=' + encodeURIComponent(props.sessionId))
          const mode = nextMode === undefined ? modeFilter : nextMode
          const provider = nextProvider === undefined ? providerFilter : nextProvider
          if (mode !== '') query.push('mode=' + encodeURIComponent(mode))
          if (provider !== '') query.push('provider=' + encodeURIComponent(provider))
          const suffix = query.length === 0 ? '' : '?' + query.join('&')
          const history = await callApi('/history' + suffix, {})
          const templates = await callApi('/templates' + (props.sessionId ? '?sessionId=' + encodeURIComponent(props.sessionId) : ''), {})
          set({ history: { prompts: history.prompts, runs: history.runs }, templates: templates.templates })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      const removePrompt = async (row) => {
        try {
          await callApi('/history/delete', { method: 'POST', body: { id: row.id, kind: 'prompt', sessionId: props.sessionId } })
          await reload()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      const removeRun = async (row) => {
        try {
          await callApi('/history/delete', { method: 'POST', body: { id: row.id, kind: 'run', sessionId: props.sessionId } })
          await reload()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      const removeTemplate = async (row) => {
        try {
          await callApi('/templates/delete', { method: 'POST', body: { id: row.id, sessionId: props.sessionId } })
          await reload()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }

      return h(React.Fragment, null,
        h('div', { style: CARD_STYLE },
          h('div', { style: ROW_STYLE },
            h('span', { style: LABEL_STYLE }, '模板'),
            h('span', { style: SPACER_STYLE }),
            h(primitives.Button, {
              variant: 'ghost',
              size: 'sm',
              icon: busy ? h(Spinner, null) : h(primitives.IconRefreshOutlineMedium, null),
              onClick: () => reload(),
            }, '刷新'),
          ),
          h('p', { style: NOTE_STYLE }, '模板是交给优化器的系统提示词，决定「怎么改」；内置模板不能覆盖。'),
          s.templates.length === 0
            ? h(Empty, { text: '还没有模板。' })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              s.templates.map((template) => h('div', {
                key: template.id,
                style: LIST_ITEM_STYLE,
              },
                h('div', { style: ROW_STYLE },
                  h('span', { style: { fontSize: 12, fontWeight: 600, color: LABEL_PRIMARY } }, template.name),
                  h('span', { style: CHIP_STYLE }, template.mode === 'system' ? '系统' : '用户'),
                  template.builtin === 1 ? h('span', { style: CHIP_STYLE }, '内置') : null,
                  h('span', { style: SPACER_STYLE }),
                  h(primitives.Button, {
                    variant: 'ghost',
                    size: 'sm',
                    onClick: () => set({ template: template.body }),
                  }, s.template === template.body ? '已选用' : '选用'),
                  template.builtin === 1
                    ? null
                    : h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(primitives.IconTrashOutlineMedium, null),
                      onClick: () => removeTemplate(template),
                    }, '删除'),
                ),
                h('p', { style: { ...NOTE_STYLE, color: LABEL_SECONDARY } }, template.body),
              )),
            ),
          s.template !== ''
            ? h('div', { style: ROW_STYLE },
              h('span', { style: CAPTION_STYLE }, '当前选用模板：'),
              h('span', { style: { ...CODE_STYLE, flex: '1 1 auto' } }, s.template.slice(0, 80)),
              h(primitives.Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: () => set({ template: '' }),
              }, '取消选用'),
            )
            : null,
        ),

        h('div', { style: CARD_STYLE },
          h('div', { style: ROW_STYLE },
            h('span', { style: LABEL_STYLE }, '历史记录'),
            h('span', { style: SPACER_STYLE }),
            h('span', { style: CAPTION_STYLE }, s.history.prompts.length + ' 个版本 / ' + s.history.runs.length + ' 次运行'),
          ),
          h('div', { style: ROW_STYLE },
            h('select', {
              style: { ...SELECT_STYLE, width: 130 },
              value: modeFilter,
              onChange: (event) => {
                setModeFilter(event.target.value)
                reload(event.target.value, providerFilter)
              },
            },
              h('option', { value: '' }, '全部类型'),
              h('option', { value: 'user' }, '用户提示词'),
              h('option', { value: 'system' }, '系统提示词'),
            ),
            h('select', {
              style: { ...SELECT_STYLE, width: 160 },
              value: providerFilter,
              onChange: (event) => {
                setProviderFilter(event.target.value)
                reload(modeFilter, event.target.value)
              },
            },
              [h('option', { key: '__all', value: '' }, '全部 provider')].concat(
                providers.map((provider) => h('option', { key: provider, value: provider }, provider)),
              ),
            ),
          ),
          s.history.prompts.length === 0 && s.history.runs.length === 0
            ? h(Empty, { text: '还没有历史记录。' })
            : h(React.Fragment, null,
              h('span', { style: LABEL_STYLE }, '版本'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                s.history.prompts.slice(0, 50).map((row) => h('div', {
                  key: row.id,
                  style: { ...LIST_ITEM_STYLE, cursor: 'default' },
                },
                  h('div', { style: ROW_STYLE },
                    h('span', { style: { fontSize: 11, color: LABEL_TERTIARY } }, '#' + row.id),
                    h('span', { style: { ...CAPTION_STYLE, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      versionTitle(row)),
                    h('span', { style: CHIP_STYLE }, row.mode === 'system' ? '系统' : '用户'),
                    h('span', { style: CHIP_STYLE }, ORIGIN_LABELS[row.origin] === undefined ? row.origin : ORIGIN_LABELS[row.origin]),
                    h('span', { style: CAPTION_STYLE }, formatTime(row.created_at)),
                    h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => props.onLoadVersion(row),
                    }, '载入'),
                    h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(primitives.IconTrashOutlineMedium, null),
                      onClick: () => removePrompt(row),
                    }, '删除'),
                  ),
                )),
              ),
              h('span', { style: LABEL_STYLE }, '运行记录'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                s.history.runs.slice(0, 50).map((row) => h('div', {
                  key: row.id,
                  style: { ...LIST_ITEM_STYLE, cursor: 'default' },
                },
                  h('div', { style: ROW_STYLE },
                    h('span', { style: CHIP_STYLE }, KIND_LABELS[row.kind] === undefined ? row.kind : KIND_LABELS[row.kind]),
                    h('span', { style: CAPTION_STYLE }, row.provider + '/' + row.model),
                    h('span', { style: CAPTION_STYLE }, formatMs(row.elapsed_ms)),
                    h('span', { style: SPACER_STYLE }),
                    h('span', { style: CAPTION_STYLE }, formatTime(row.created_at)),
                    row.error !== null && row.error !== undefined
                      ? h('span', { style: { fontSize: 11, color: DANGER } }, '失败')
                      : null,
                    h(primitives.Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(primitives.IconTrashOutlineMedium, null),
                      onClick: () => removeRun(row),
                    }, '删除'),
                  ),
                  row.error !== null && row.error !== undefined
                    ? h('p', { style: { ...NOTE_STYLE, color: DANGER } }, row.error)
                    : null,
                )),
              ),
            ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // The panel
    // -----------------------------------------------------------------------

    /**
     * The workbench.
     *
     * All state lives here and the panes are pure: the panel owns the single
     * source of truth (input, result, version chain, catalog, history), and a
     * failed request surfaces in one place instead of in each pane.
     */
    function StudioPanel(props) {
      const ctx = props.ctx

      // `main` is a ROOT-scoped seat: its `inject` receives the slot's actions,
      // never a session id, and the catalog binds a Session only to the reserved
      // `conversation` key. The renderer instead materialises every standard hook
      // into a `use<Name>` prop (materializeStandardBinding + standardHookPropName),
      // so the active session arrives through `props.useSessions`. A host without a
      // session catalog passes nothing, hence the hookless stand-in: the hook call
      // stays unconditional while the panel simply runs session-less.
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions
      const sessionId = useSessions(selectSessionId)

      // The workspace catalog, for the「在新对话中使用」target list. Same
      // stand-in rule as the session hook above: a host that installs no
      // workspace catalog yields no rows and the picker falls back to the
      // host's own directory chooser.
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : useNoWorkspaces
      const knownWorkspaces = workspaceRows(useWorkspaces((snapshot) => snapshot))

      const [tab, setTab] = useState('optimize')
      const [state, setState] = useState({
        routes: [],
        failures: [],
        route: '',
        routePinned: false,
        mode: 'user',
        input: '',
        result: '',
        resultMeta: null,
        template: '',
        chain: [],
        baseId: null,
        templates: [],
        history: { prompts: [], runs: [] },
        busy: null,
        busySince: null,
        error: null,
        notice: null,
        version: null,
        newChatOpen: false,
        iterateOpen: false,
        iterateDirection: '',
        templateOpen: false,
        templateName: '',
      })

      const set = useCallback((patch) => {
        setState((current) => ({ ...current, ...patch }))
      }, [])

      // An explicit pick outranks every automatic guess: once the user has
      // chosen a route, a later refresh that learns which model this
      // conversation runs on must not quietly move the selector out from under
      // them. Only a route the catalog no longer offers is replaced.
      const chooseRoute = useCallback((value) => {
        setState((current) => ({ ...current, route: value, routePinned: true }))
      }, [])

      // The workspace, for the footer. The Host resolves it authoritatively from
      // the session id; this is display only, and a session-less host shows none.
      const workspace = useSessions(selectWorkspace)

      const refresh = useCallback(async () => {
        try {
          const suffix = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
          const models = await callApi('/models' + suffix, {})
          const templates = await callApi('/templates' + suffix, {})
          const history = await callApi('/history' + suffix, {})
          const routes = models.routes === undefined ? [] : models.routes
          setState((current) => {
            // A pinned pick survives refresh while the catalog still offers it.
            // Everything else is recomputed from scratch on every refresh, in
            // this order: the route this conversation already talks on, then the
            // configured default, then the first catalog entry. Recomputing
            // matters because the session id arrives a beat after the first
            // render — a route guessed before then must yield to the real one.
            let route = current.route
            const stillOffered = routes.some((entry) => routeKey(entry) === route)
            if (!(current.routePinned && stillOffered)) {
              const candidates = [
                models.sessionProvider !== '' && models.sessionModel !== ''
                  ? models.sessionProvider + '/' + models.sessionModel
                  : '',
                models.defaultProvider !== '' && models.defaultModel !== ''
                  ? models.defaultProvider + '/' + models.defaultModel
                  : '',
              ]
              route = ''
              for (const candidate of candidates) {
                if (candidate !== '' && routes.some((entry) => routeKey(entry) === candidate)) {
                  route = candidate
                  break
                }
              }
              if (route === '' && routes.length > 0) route = preferredRoute(routes)
            }
            return {
              ...current,
              routes,
              failures: models.failures === undefined ? [] : models.failures,
              route,
              routePinned: current.routePinned && stillOffered,
              templates: templates.templates === undefined ? [] : templates.templates,
              history: {
                prompts: history.prompts === undefined ? [] : history.prompts,
                runs: history.runs === undefined ? [] : history.runs,
              },
              error: null,
            }
          })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set])

      const health = useCallback(async () => {
        try {
          const suffix = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
          const info = await callApi('/health' + suffix, {})
          set({ version: info.version, notice: info.llm === 'missing' ? '当前 DSH 没有可用的 llm 服务，模型调用不可用。' : null })
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set])

      useEffect(() => {
        refresh()
        health()
      }, [refresh, health])

      const route = parseRouteKey(state.route)

      const runOptimize = useCallback(async () => {
        if (route === null) {
          set({ error: '请先选择一个模型。' })
          return
        }
        set({ busy: 'optimize', busySince: Date.now(), error: null, notice: null })
        try {
          const result = await callApi('/optimize', {
            method: 'POST',
            body: {
              prompt: state.input,
              mode: state.mode,
              provider: route.provider,
              model: route.model,
              template: state.template,
              sessionId,
            },
          })
          setState((current) => ({
            ...current,
            busy: null,
            busySince: null,
            result: result.optimized,
            resultMeta: { provider: result.provider, model: result.model, elapsedMs: result.elapsedMs, stored: result.stored },
            baseId: result.promptId === null ? null : result.promptId,
            chain: result.promptId === null ? [] : [{ id: result.promptId, content: result.optimized, origin: 'optimize', mode: current.mode, title: result.optimized.slice(0, 60), created_at: Date.now() }],
            notice: result.stored === false ? '结果已返回，但当前工作区无法写入数据库，历史没有记录。' : null,
          }))
          refresh()
        } catch (error) {
          set({ busy: null, busySince: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [route, state.input, state.mode, state.template, sessionId, set, refresh])

      const runIterate = useCallback(async (direction) => {
        if (route === null) {
          set({ error: '请先选择一个模型。' })
          return
        }
        set({ busy: 'iterate', busySince: Date.now(), error: null, notice: null })
        try {
          const result = await callApi('/iterate', {
            method: 'POST',
            body: {
              prompt: state.result.trim() !== '' ? state.result : state.input,
              mode: state.mode,
              direction,
              provider: route.provider,
              model: route.model,
              parentId: state.baseId === undefined ? null : state.baseId,
              sessionId,
            },
          })
          setState((current) => {
            // An iteration is a new link in the chain: append it so the user can
            // walk back to any earlier version. `baseId` moves to the new head,
            // which is what the next iteration will use as its parent.
            const appended = result.promptId === null
              ? current.chain
              : current.chain.concat([{
                id: result.promptId,
                content: result.optimized,
                origin: 'iterate',
                mode: current.mode,
                title: result.optimized.slice(0, 60),
                created_at: Date.now(),
              }])
            return {
              ...current,
              busy: null,
              busySince: null,
              result: result.optimized,
              resultMeta: { provider: result.provider, model: result.model, elapsedMs: result.elapsedMs, stored: result.stored },
              baseId: result.promptId === null ? current.baseId : result.promptId,
              chain: appended,
              iterateOpen: false,
              iterateDirection: '',
              notice: result.stored === false ? '结果已返回，但当前工作区无法写入数据库，历史没有记录。' : null,
            }
          })
          refresh()
        } catch (error) {
          set({ busy: null, busySince: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [route, state.result, state.input, state.mode, state.baseId, sessionId, set, refresh])

      // The iteration direction is collected inline, never through
      // `window.prompt`: Electron refuses that API outright and the rejection
      // disappears into the React event handler, which is why 「迭代」 used to
      // do nothing at all. Opening the row is a plain state flip; the request
      // itself only fires from the row's own button or Enter.
      const onToggleIterate = useCallback(() => {
        setState((current) => {
          if (current.iterateOpen) return { ...current, iterateOpen: false, iterateDirection: '' }
          return { ...current, iterateOpen: true, error: null, notice: null }
        })
      }, [])

      const onCloseIterate = useCallback(() => {
        set({ iterateOpen: false, iterateDirection: '' })
      }, [set])

      const onIterate = useCallback(() => {
        const direction = typeof state.iterateDirection === 'string' ? state.iterateDirection.trim() : ''
        set({ iterateOpen: false, iterateDirection: '' })
        runIterate(direction)
      }, [runIterate, set, state.iterateDirection])

      const onCopy = useCallback(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          set({ notice: '已复制到剪贴板。' })
        } catch (error) {
          set({ error: '复制失败：' + (error instanceof Error ? error.message : String(error)) })
        }
      }, [set])

      // ---------------------------------------------------------------------
      // 「在新对话中使用」: hand the (possibly hand-edited) result to a brand new
      // conversation and send it there, so the workbench output becomes the
      // opening message instead of something to copy by hand.
      //
      // The target workspace is the user's choice, never a guess: the panel
      // lists the workspaces the catalog already knows plus the host's own
      // folder chooser, and `workspaces.create` is idempotent per path, so
      // re-picking a folder never piles up duplicates.
      //
      // Filling and sending happen inside `openWorkspace`'s `beforeOpen`
      // callback. That is the one moment that is both late enough (the Session
      // is retained, so `conversation.input.shell` resolves a binding) and
      // early enough (no later navigation can steal the main view), which is
      // what makes the draft land in the new conversation rather than in the
      // one the user came from.
      // ---------------------------------------------------------------------
      const onUseInNewChat = useCallback((text) => {
        const body = typeof text === 'string' ? text : ''
        if (body.trim() === '') {
          set({ notice: '还没有可用的优化结果。', newChatOpen: false })
          return
        }
        set({ newChatOpen: true, error: null, notice: null })
      }, [set])

      const closeNewChat = useCallback(() => set({ newChatOpen: false }), [set])

      const sendToWorkspace = useCallback(async (text, workspaceId, label) => {
        const body = typeof text === 'string' ? text : ''
        const service = (key) => {
          try {
            return typeof ctx.get === 'function' ? ctx.get(key) : undefined
          } catch (error) {
            return undefined
          }
        }
        const uiWorkspace = service('uiWorkspace')
        if (uiWorkspace === undefined || typeof uiWorkspace.openWorkspace !== 'function') {
          set({ error: '这个宿主没有提供工作区服务，「在新对话中使用」暂时不可用。', newChatOpen: false })
          return
        }
        set({ busy: 'newchat', error: null, notice: null, newChatOpen: false })
        let sent = false
        let filled = false
        try {
          await uiWorkspace.openWorkspace(workspaceId, (nextSessionId) => {
            // A failure in here must not abort the navigation: `beforeOpen`
            // throwing would release the Session and leave the user nowhere.
            try {
              const conversation = service('conversation')
              const hub = conversation === undefined ? undefined : conversation.input
              if (hub === undefined || typeof hub.shell !== 'function') return
              let shell
              try {
                shell = hub.shell(nextSessionId)
              } catch (error) {
                return
              }
              if (shell === undefined || typeof shell.setDraft !== 'function') return
              shell.setDraft(body)
              filled = true
              if (shell.actions !== undefined && typeof shell.actions.submit === 'function') {
                shell.actions.submit()
                // A committed send clears the draft; a draft still standing
                // means the composer refused it and the user should send it.
                const snapshot = shell.snapshot
                sent = snapshot !== undefined && snapshot !== null &&
                  String(snapshot.draft).trim() === ''
              }
            } catch (error) {
              filled = false
            }
          })
          set({
            busy: null,
            notice: sent
              ? '已在新对话中使用（' + label + '），内容已发送。'
              : filled
                ? '已在新对话中使用（' + label + '），内容已填入输入框，请确认后发送。'
                : '已打开新对话（' + label + '），但没能自动填入内容，请手动粘贴。',
          })
        } catch (error) {
          set({ busy: null, error: '打开新对话失败：' + (error instanceof Error ? error.message : String(error)) })
        }
      }, [ctx, set])

      const onUseInNewChatPick = useCallback((text, workspace) => {
        sendToWorkspace(text, workspace.workspaceId, workspace.title === '' ? workspace.path : workspace.title)
      }, [sendToWorkspace])

      const onUseInNewChatBrowse = useCallback(async (text) => {
        const body = typeof text === 'string' ? text : ''
        const service = (key) => {
          try {
            return typeof ctx.get === 'function' ? ctx.get(key) : undefined
          } catch (error) {
            return undefined
          }
        }
        const uiWorkspace = service('uiWorkspace')
        const workspaces = service('workspaces')
        if (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== 'function') {
          set({ error: '这个宿主没有提供目录选择服务，「在新对话中使用」暂时不可用。', newChatOpen: false })
          return
        }
        let path
        set({ busy: 'newchat', error: null, notice: null })
        try {
          path = await uiWorkspace.pickDirectory()
        } catch (error) {
          set({ busy: null, error: '打开目录选择器失败：' + (error instanceof Error ? error.message : String(error)) })
          return
        }
        if (path === null || path === undefined) {
          // The user dismissed the chooser: keep the picker open, say nothing.
          set({ busy: null })
          return
        }
        if (workspaces === undefined || typeof workspaces.create !== 'function') {
          set({ busy: null, error: '这个宿主没有提供工作区服务，无法为选中的目录建立工作区。' })
          return
        }
        let workspace
        try {
          workspace = await workspaces.create({ path })
        } catch (error) {
          set({ busy: null, error: '建立工作区失败：' + (error instanceof Error ? error.message : String(error)) })
          return
        }
        set({ busy: null })
        await sendToWorkspace(body, workspace.workspaceId, workspace.title === '' ? workspace.path : workspace.title)
      }, [ctx, sendToWorkspace, set])

      // Same rule as the iteration direction: no `window.prompt`. The name is
      // typed into an inline row that replaces the button row while it is open.
      const onSaveTemplate = useCallback(async (text) => {
        const name = typeof state.templateName === 'string' ? state.templateName.trim() : ''
        if (name === '') {
          set({ error: '请先填写模板名称。' })
          return
        }
        try {
          const result = await callApi('/templates/save', {
            method: 'POST',
            body: { name, mode: state.mode, body: text, sessionId },
          })
          set({ notice: result.replaced ? '已覆盖模板「' + name + '」。' : '已保存模板「' + name + '」。', templateOpen: false, templateName: '' })
          refresh()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [state.mode, state.templateName, sessionId, set, refresh])

      const onPersist = useCallback(async (text) => {
        try {
          const result = await callApi('/prompts/save', {
            method: 'POST',
            body: { content: text, mode: state.mode, sessionId },
          })
          set({ notice: '已存入历史（#' + result.id + '）。' })
          refresh()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [state.mode, sessionId, set, refresh])

      const onLoadVersion = useCallback(async (row) => {
        try {
          const result = await callApi('/prompt?id=' + row.id + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''), {})
          setState((current) => ({
            ...current,
            input: result.prompt.content,
            result: result.prompt.content,
            mode: result.prompt.mode,
            baseId: result.prompt.id,
            chain: result.chain === undefined ? [] : result.chain,
          }))
          // `tab` is its own useState, not a field of `state` — writing
          // `tab: 'optimize'` into the state patch did nothing, so loading a
          // version from the library filled the workbench behind a tab the user
          // was no longer looking at. The real setter is the only thing that
          // switches the view.
          setTab('optimize')
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set, setTab])

      const onPickVersion = useCallback((row) => {
        set({ result: row.content, baseId: row.id, mode: row.mode === 'system' ? 'system' : 'user' })
      }, [set])

      const onDeleteVersion = useCallback(async (row) => {
        try {
          await callApi('/history/delete', { method: 'POST', body: { id: row.id, kind: 'prompt', sessionId } })
          refresh()
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
        }
      }, [sessionId, set, refresh])

      const paneProps = {
        state,
        set,
        chooseRoute,
        sessionId,
        workspaces: knownWorkspaces,
        onOptimize: runOptimize,
        onIterate,
        onToggleIterate,
        onCloseIterate,
        onToggleTemplate: () => setState((current) => (
          current.templateOpen
            ? { ...current, templateOpen: false, templateName: '' }
            : { ...current, templateOpen: true, error: null, notice: null }
        )),
        onCloseTemplate: () => set({ templateOpen: false, templateName: '' }),
        onCopy,
        onSaveTemplate,
        onPersist,
        onPickVersion,
        onDeleteVersion,
        onLoadVersion,
        onUseInNewChat,
        onUseInNewChatPick,
        onUseInNewChatBrowse,
        onCloseNewChat: closeNewChat,
      }

      return h('div', { style: PANEL_STYLE },
        h('div', { style: HEADER_STYLE },
          h('span', { style: { display: 'inline-flex', color: ACCENT } }, h(StudioIcon, null)),
          h('h2', { style: TITLE_STYLE }, '提示词工作台'),
          state.version !== null
            ? h('span', { style: CAPTION_STYLE }, 'v' + state.version)
            : null,
          h('span', { style: SPACER_STYLE }),
          h(primitives.Button, {
            variant: 'ghost',
            size: 'sm',
            icon: state.busy === 'refresh' ? h(Spinner, null) : h(primitives.IconRefreshOutlineMedium, null),
            onClick: () => {
              set({ busy: 'refresh' })
              Promise.resolve(refresh()).finally(() => set({ busy: null }))
            },
          }, '刷新'),
        ),

        h('div', { style: { padding: '8px 14px 0', flex: '0 0 auto' } },
          h(primitives.SegmentedControl, {
            id: 'dsh-prompt-studio-tab',
            value: tab,
            options: [
              { value: 'optimize', label: '优化' },
              { value: 'library', label: '模板与历史' },
            ],
            label: '工作台区域',
            onChange: setTab,
          }),
        ),

        h('div', { style: BODY_STYLE },
          state.notice !== null
            ? h('p', { style: NOTICE_STYLE }, state.notice)
            : null,
          tab === 'optimize' ? h(OptimizePane, paneProps) : null,
          tab === 'library' ? h(LibraryPane, paneProps) : null,
        ),

        h('div', {
          style: {
            flex: '0 0 auto',
            padding: '6px 14px',
            borderTop: '1px solid ' + BORDER_L1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          },
        },
          h('span', { style: CAPTION_STYLE },
            '模型 ' + state.routes.length + ' 个'),
          h('span', { style: CAPTION_STYLE },
            workspace === null ? '工作区（未知）' : workspace),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Register the rail entry and the panel.
     *
     * Both seats are registered from the innermost `slots.inject` callback so they
     * appear together or not at all; the returned function releases both. The
     * callbacks only run once the host shell has DECLARED those seats, so a shell
     * that does not declare them leaves the panel unmounted instead of failing the
     * boot.
     */
    function apply(ctx) {
      try {
        if (ctx.slots === undefined || ctx.slots === null) {
          console.error('dsh-prompt-studio: this DSH has no slots service; the workbench stays unmounted')
          return
        }
        // The spinner and the busy bar are inline-styled, so their keyframes
        // have to be installed by hand before anything can animate.
        installKeyframes()
        ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const stopMain = ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                // A ROOT-scoped `inject` is called with the slot's `actions`, not
                // with a session id, so only `ctx` is handed over here; the panel
                // reads the active session through its `useSessions` standard prop.
                inject: () => ({ ctx }),
              },
              StudioPanel,
            )
            const stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 46, label: () => '提示词' },
              StudioIcon,
            )
            return () => {
              if (typeof stopIcon === 'function') stopIcon()
              if (typeof stopMain === 'function') stopMain()
            }
          }),
        )
      } catch (error) {
        console.error('dsh-prompt-studio: registering the workbench panel failed', error)
      }
    }

    /** `slots` is the one service this module needs before it can do anything. */
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
