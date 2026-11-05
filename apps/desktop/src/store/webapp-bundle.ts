/**
 * A Webapp tab moves onto the bundle its gateway serves now.
 *
 * `hermes update` restarts the gateway first and rebuilds the Webapp bundle after it, so a tab
 * reconnects to the new backend while still running the old JavaScript. The page records the
 * bundle it booted (`__HERMES_WEBAPP_BUNDLE__`, injected by `_serve_index`); the gateway reports
 * the bundle a page load gets now (`GET /api/webapp/bundle`). When they differ the tab reloads
 * once, but only onto a CURRENT bundle: a rebuild that failed leaves the old bundle marked stale,
 * its page load is refused, and reloading would replace a working tab with that refusal.
 *
 * Native Desktop ships its renderer inside the app and never reloads for a backend's bundle.
 */

import { requestComposerGetDraft } from '@/app/chat/composer/focus'
import { hostHas } from '@/lib/host-capabilities'
import { $composerAttachments } from '@/store/composer'
import { $gatewayState } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

interface ServedBundle {
  id: null | string
  current: boolean
}

// The id this tab last reloaded for. A second boot that still runs another bundle (a proxy
// serving a cached page) must not reload again: at most one reload per served bundle.
const RELOADED_FOR_KEY = 'hermes.webapp.reloadedForBundle'
const CHECK_INTERVAL_MS = 60_000

/** The bundle this page booted, or null where nothing served one (native Desktop, a dev server). */
export function bootedBundle(): null | string {
  const id = (window as Window & { __HERMES_WEBAPP_BUNDLE__?: unknown }).__HERMES_WEBAPP_BUNDLE__

  return hostHas('servedBundleReload') && typeof id === 'string' && id ? id : null
}

/** Nothing on screen a reload would cut off: no turn running or waiting on the user, no unsent
 *  attachment, and no text in the composer being typed in. That text lives in the editor, not in a
 *  store (the saved draft trails it by a debounce), so it is read from the mounted composer. */
async function tabIdle(): Promise<boolean> {
  const live = Object.values($sessionStates.get()).some(
    state => state && (state.busy || state.awaitingResponse || state.turnLive || state.needsInput)
  )

  if (live || $composerAttachments.get().length > 0) {
    return false
  }

  const draft = await requestComposerGetDraft([], { active: true })

  return !draft?.text?.trim()
}

async function servedBundle(): Promise<ServedBundle | null> {
  try {
    return await window.hermesDesktop.api<ServedBundle>({ path: '/api/webapp/bundle', timeoutMs: 5000 })
  } catch {
    return null
  }
}

let reload: () => void = () => window.location.reload()
let checking = false

function reloadOnto(id: string): void {
  try {
    if (sessionStorage.getItem(RELOADED_FOR_KEY) === id) {
      return
    }

    sessionStorage.setItem(RELOADED_FOR_KEY, id)
  } catch {
    // Without storage there is no loop guard: never reload blind.
    return
  }

  reload()
}

/** Reload this tab when its gateway now serves a different, current bundle. A busy tab is left
 *  alone; the next check asks again. */
export async function reloadOntoServedBundle(): Promise<void> {
  const booted = bootedBundle()

  if (!booted || checking) {
    return
  }

  checking = true

  try {
    const served = await servedBundle()

    if (!served?.current || !served.id || served.id === booted) {
      return
    }

    if (await tabIdle()) {
      reloadOnto(served.id)
    }
  } finally {
    checking = false
  }
}

/** Check on every (re)connect and once a minute: the rebuild finishes after the gateway is back,
 *  so the reconnect alone comes too early, and a tab that was busy is asked again. Returns the
 *  stop function. */
export function startServedBundleWatch(): () => void {
  if (!bootedBundle()) {
    return () => undefined
  }

  const timer = window.setInterval(() => void reloadOntoServedBundle(), CHECK_INTERVAL_MS)

  const unsub = $gatewayState.listen(state => {
    if (state === 'open') {
      void reloadOntoServedBundle()
    }
  })

  return () => {
    window.clearInterval(timer)
    unsub()
  }
}

/** Tests: replace the navigation and drop module state. */
export function setBundleReloadForTests(next: (() => void) | null): void {
  reload = next ?? (() => window.location.reload())
  checking = false
}
