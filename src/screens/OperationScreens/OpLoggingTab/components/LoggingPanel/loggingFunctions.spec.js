// Copyright ©️ 2026 Sebastian Delmont <sd@ham2k.com>
// SPDX-License-Identifier: MPL-2.0

// Regression tests for the "Tell PoLo" post-log freq/mode revert.
//
// The bug: a SOTAcat deep link sets the right frequency and mode on the current
// QSO, but once that QSO is logged, the NEXT one reverts to the old freq/mode.
// Two causes:
//   1. New QSOs copy their freq/mode from the VFO (prepareNewQSO), but the
//      deep-link path never updated the VFO, so the next QSO used stale values.
//   2. The blank QSO showing when the link arrived was saved to a queue and then
//      restored after logging, bringing back the pre-link freq/mode.
//
// The fix updates the VFO from the deep link's freq/mode, and stops queuing a blank
// QSO the operator never started. (Spots reach logging the same way, so they get
// the same VFO carry-forward.)
//
// Testing note: cause 2 only happens when a blank QSO is already on screen, so each
// test seeds one first; an earlier test that skipped this step missed the bug. The
// tests drive the real manageNextQSO/prepareNewQSO with the exact URLs SOTAcat
// emits, parsed the way DeepLinks.jsx parses them.

import { manageNextQSO } from './loggingFunctions'
import { buildSuggestedQSO } from '../../../../../DeepLinkUtils'
import { setVFO } from '../../../../../store/station/stationSlice'
import { bandForFrequency } from '@ham2k/lib-operation-data'

jest.mock('@ham2k/lib-operation-data', () => ({
  bandForFrequency: (freq) => {
    if (freq >= 14000 && freq < 14350) return '20m'
    if (freq >= 7000 && freq < 7300) return '40m'
    return undefined
  },
  modeForFrequency: (freq) => (freq < 10000 ? 'CW' : 'SSB')
}))

jest.mock('../../../../../extensions/registry', () => ({
  findHooks: (category, { key } = {}) => {
    if (category !== 'activity') return []
    // Activities carry no `prepareNewQSO`, so the QSO-prep hooks are inert here.
    const hooks = [
      { key: 'sota', activationType: 'sotaActivation', huntingType: 'sota' },
      { key: 'pota', activationType: 'potaActivation', huntingType: 'pota' }
    ]
    return key ? hooks.filter(h => h.key === key) : hooks
  }
}))

// DeepLinkUtils imports addNewOperation/setOperationData at module load; stub so
// importing it is harmless.
jest.mock('../../../../../store/operations', () => ({
  addNewOperation: (operation) => async () => ({ uuid: 'new-op-uuid', ...operation }),
  setOperationData: (data) => async () => data
}))

// Back the UI-state helpers with the real (state.ui[component][key]) shape so
// manageNextQSO can read/write the in-progress QSO through our harness store.
jest.mock('../../../../../store/ui', () => ({
  setStateForComponentAndKey: (payload) => ({ type: 'ui/setStateForComponentAndKey', payload }),
  selectStateForComponentAndKey: (state, component, key) => state?.ui?.[component]?.[key]
}))

jest.mock('./useCallLookup', () => ({ resetCallLookupCache: () => () => {} }))

// Stub the station slice so importing loggingFunctions doesn't pull in
// @reduxjs/toolkit (ESM, untransformed by the RN jest preset). The harness below
// applies the resulting setVFO action, mirroring the real reducer (merge freq/mode,
// recompute band from freq).
jest.mock('../../../../../store/station/stationSlice', () => ({
  setVFO: (payload) => ({ type: 'station/setVFO', payload })
}))

// --- harness: a minimal store that applies the only two action kinds these paths
// dispatch (UI-state writes and VFO writes), so VFO round-trips like production.
function makeHarness (initialVFO) {
  const state = { ui: {}, vfo: { ...initialVFO } }
  const getState = () => state
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, getState)
    if (action?.type === 'ui/setStateForComponentAndKey') {
      const { component, key, value } = action.payload
      state.ui[component] = state.ui[component] || {}
      state.ui[component][key] = value
    } else if (action?.type === 'station/setVFO') {
      const data = { ...action.payload }
      if (data.freq) data.band = bandForFrequency(data.freq)
      state.vfo = { ...state.vfo, ...data }
    }
    return action
  }
  return {
    dispatch,
    getState,
    vfo: () => state.vfo,
    currentQSO: () => state.ui.OpLoggingTab?.qso
  }
}

const OPERATION = { uuid: 'op-1', local: {} }

// Exactly what SOTAcat's buildXotaDeepLink() emits (path-form, frequency in Hz).
const URL_SETUP = 'com.ham2k.polo:///qso?our.refs=sota%3AW6%2FNC-298&returnpath=http%3A%2F%2Fsotacat.local'
const URL_TELL = 'com.ham2k.polo:///qso?our.refs=sota%3AW6%2FNC-298&frequency=14285000&mode=SSB&returnpath=http%3A%2F%2Fsotacat.local'
const URL_CHASE = 'com.ham2k.polo:///qso?their.call=K1ABC&their.refs=pota%3AUS-1234&frequency=7185000&mode=CW&returnpath=http%3A%2F%2Fsotacat.local'

// Parse the SOTAcat URL the way DeepLinks.jsx does (inline `new URL` on the
// path), then build the suggested QSO from the resulting params.
function suggestedFromURL (url) {
  const [, rest] = url.split('://')
  const [hostname, ...restParts] = rest.split('/')
  const urlObject = new URL(`https://${hostname || 'default:1'}/${restParts.join('/')}`)
  const params = Object.fromEntries(urlObject.searchParams)
  return buildSuggestedQSO(params, url).qso
}

// Models the user logging the in-progress QSO: clear the form, then ask for the
// next QSO from the current VFO, exactly what LoggingPanel does after addQSOs().
function logCurrentAndAdvance (h) {
  const logged = h.currentQSO()
  h.dispatch({ type: 'ui/setStateForComponentAndKey', payload: { component: 'OpLoggingTab', key: 'qso', value: undefined } })
  h.dispatch(manageNextQSO({ qsos: [logged], operation: OPERATION, vfo: h.vfo(), settings: {} }))
  return h.currentQSO()
}

// Mirror the app's steady state right after logging a contact: a blank new QSO is
// already showing, seeded from the current VFO. This is the precondition the
// on-device revert needs, the deep link queues this blank, and (pre-fix) the
// post-log step restores it. Without seeding it, nothing is queued and the bug hides.
function seedBlankQSO (h) {
  h.dispatch(manageNextQSO({ qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))
}

describe('Tell PoLo deep link → log → next QSO (last known good)', () => {
  // Passes with or without the fix: SOTAcat's frequency (Hz) and mode reach the in-progress QSO.
  it('applies the Tell-PoLo freq/mode to the in-progress QSO', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_TELL), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    const qso = h.currentQSO()
    expect(qso.freq).toBe(14285) // 14285000 Hz / 1000
    expect(qso.mode).toBe('SSB')
    expect(qso.band).toBe('20m')
  })

  // Fails without the fix (fix-point 1): applying the link should make 14285/SSB the VFO, so it
  // becomes "last known good" for whatever QSO comes next.
  it('updates the VFO to the Tell-PoLo freq/mode', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_TELL), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    expect(h.vfo().freq).toBe(14285)
    expect(h.vfo().mode).toBe('SSB')
  })

  // Fails without the fix (the visible symptom): log the deep-linked QSO, and the next blank QSO
  // reverts to the pre-deep-link 7000/SSB instead of staying on 14285/SSB.
  it('keeps the next QSO on the most recent freq/mode after logging', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    seedBlankQSO(h) // operator is sitting on a blank QSO at 7000 when the link arrives
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_TELL), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    const next = logCurrentAndAdvance(h)
    expect(next.freq).toBe(14285)
    expect(next.mode).toBe('SSB')
    expect(next.band).toBe('20m')
  })

  // Control (passes with or without the fix): when the VFO IS written (as a manual freq
  // edit does), carry-forward works, isolating the missing auto-write as the sole gap.
  it('carries the VFO forward to a new QSO when the VFO has been written', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    h.dispatch(setVFO({ freq: 14285, mode: 'SSB' })) // what editing the freq field dispatches

    h.dispatch(manageNextQSO({ qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))
    const qso = h.currentQSO()
    expect(qso.freq).toBe(14285)
    expect(qso.mode).toBe('SSB')
    expect(qso.band).toBe('20m')
  })

  // Passes with or without the fix: the queue is still right for its real purpose. If the
  // operator HAD started a contact (a call entered) when the deep link arrived, that
  // interrupted entry must be preserved and restored after the deep-linked QSO is logged;
  // only EMPTY blanks are dropped. Guards against the fix over-reaching and discarding real work.
  it('preserves an interrupted entry (with a call) across a deep link', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    seedBlankQSO(h)
    const started = { ...h.currentQSO(), their: { call: 'N0CALL' } } // operator typed a call
    h.dispatch({ type: 'ui/setStateForComponentAndKey', payload: { component: 'OpLoggingTab', key: 'qso', value: started } })

    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_TELL), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    const next = logCurrentAndAdvance(h)
    expect(next.their?.call).toBe('N0CALL')
    expect(next.freq).toBe(7000)
  })
})

describe('qrx Setup → Tell PoLo sequence', () => {
  // Passes with or without the fix: the setup link (our.refs only) carries no freq/mode.
  it('the Setup link leaves the in-progress QSO without a freq', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_SETUP), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))
    expect(h.currentQSO().freq).toBeUndefined()
  })

  // Fails without the fix: Setup, then Tell PoLo, then log, next QSO must stay on 14285/SSB.
  it('stays on last-known-good after Setup → Tell PoLo → log', () => {
    const h = makeHarness({ band: '40m', freq: 7000, mode: 'SSB' })
    seedBlankQSO(h) // blank QSO at 7000 showing before the Setup link
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_SETUP), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_TELL), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    const next = logCurrentAndAdvance(h)
    expect(next.freq).toBe(14285)
    expect(next.mode).toBe('SSB')
  })
})

describe('SOTAcat chase page deep link', () => {
  // Passes with or without the fix: chase freq/mode/their.call reach the in-progress QSO.
  it('applies the chase freq/mode and their.call to the in-progress QSO', () => {
    const h = makeHarness({ band: '20m', freq: 14250, mode: 'SSB' })
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_CHASE), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    const qso = h.currentQSO()
    expect(qso.freq).toBe(7185) // 7185000 Hz / 1000
    expect(qso.mode).toBe('CW')
    expect(qso.their.call).toBe('K1ABC')
  })

  // Fails without the fix: after logging a chase QSO, the next QSO must stay on 7185/CW and
  // must NOT carry the worked station's call forward.
  it('keeps the next QSO on the chase freq/mode after logging', () => {
    const h = makeHarness({ band: '20m', freq: 14250, mode: 'SSB' })
    seedBlankQSO(h) // blank QSO at 14250 showing before the chase link
    h.dispatch(manageNextQSO({ suggestedQSO: suggestedFromURL(URL_CHASE), qsos: [], operation: OPERATION, vfo: h.vfo(), settings: {} }))

    const next = logCurrentAndAdvance(h)
    expect(next.freq).toBe(7185)
    expect(next.mode).toBe('CW')
    expect(next.band).toBe('40m')
    expect(next.their?.call).toBeUndefined()
  })
})
