// Copyright ©️ 2026 Sebastian Delmont <sd@ham2k.com>
// SPDX-License-Identifier: MPL-2.0

// Pure helpers for Ham2K deep links, kept apart from the headless component in
// `DeepLinks.jsx` so they can be unit-tested without the React Native harness.

import { bandForFrequency } from '@ham2k/lib-operation-data'

import { findHooks } from './extensions/registry'
import { addNewOperation, setOperationData } from './store/operations'

const DEBUG = false

export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Build the suggested QSO from the deep-link parameters.
 *
 * Returns `{ qso, ourRefs }`, where `qso` is the suggested QSO (the station being
 * worked and its hunted references) and `ourRefs` are our own activation
 * references; used to select the operation, not placed on the QSO.
 */
export function buildSuggestedQSO (params, url) {
  let freq
  if (params.freq) {
    freq = Number(params.freq)
  } else if (params.frequency) {
    freq = Number(params.frequency) / 1000
  }
  const band = freq ? bandForFrequency(freq) : params.band

  const qso = {
    uuid: 'suggested-qso',
    their: {},
    band,
    freq,
    mode: params.mode?.toUpperCase(),
    startAtMillis: params.startAtMillis ? Number(params.startAtMillis) : undefined,
    _suggestedKey: url
  }

  if (params['their.call']) qso.their.call = params['their.call'].toUpperCase()

  // their.refs: hunted references, placed on the QSO, mapped from the
  // activity key (e.g. `pota`) to its hunting type.
  const theirRefs = parseRefs(params['their.refs'])
  if (theirRefs?.length) {
    qso.refs = theirRefs.map(({ type, ref }) => ({ type: huntingTypeForKey(type) ?? type, ref }))
  }

  // our.refs: our own activation references, used to select the operation.
  const ourRefs = parseRefs(params['our.refs'])

  return { qso, ourRefs }
}

/**
 * Find a recent operation activating exactly `ourRefs`, or create one.
 *
 * Matching is an exact set comparison: an operation is reused only when its
 * activation references are precisely the requested set, no more, no less.
 * A park-only request must not latch onto a park+summit operation (those are
 * distinct activations), and a park+summit request must not reuse a park-only
 * operation.
 */
export async function findOrCreateOperation ({ ourRefs, operations, dispatch }) {
  const cutoff = Date.now() - RECENT_WINDOW_MS
  const wantedRefs = ourRefs.map(({ type, ref }) => ({ type: activationTypeForKey(type), ref }))

  const existingOp = Object.values(operations || {}).find(op => {
    if (!op || op.deleted) return false
    const lastActive = op.startAtMillisMax || op.createdAtMillis || 0
    if (lastActive < cutoff) return false
    return sameRefSet(op.refs, wantedRefs)
  })
  if (existingOp) return existingOp

  const newOperation = await dispatch(addNewOperation({ refs: wantedRefs, _isNew: true }))

  // Trigger ref decoration and title derivation
  await dispatch(setOperationData({ uuid: newOperation.uuid, refs: newOperation.refs }))

  return newOperation
}

/**
 * True when an operation's references are exactly the same set as `wantedRefs`
 * (same type:ref pairs, in any order).
 */
function sameRefSet (opRefs, wantedRefs) {
  const present = (opRefs || []).filter(r => r?.type && r?.ref)
  if (present.length !== wantedRefs.length) return false
  const keyOf = r => `${r.type}:${r.ref}`
  const opKeys = new Set(present.map(keyOf))
  return wantedRefs.every(r => opKeys.has(keyOf(r)))
}

export function activationTypeForKey (key) {
  return findHooks('activity', { key })[0]?.activationType
}

export function huntingTypeForKey (key) {
  return findHooks('activity', { key })[0]?.huntingType
}

/**
 * Parse a comma-separated list of `type:ref` pairs into `[{ type, ref }]`.
 * Types are matched against the activity registry; unknown types are skipped.
 * Returns `undefined` when the string is empty or yields no valid pairs.
 */
export function parseRefs (refsString) {
  if (!refsString) return undefined

  const refs = []
  refsString.split(',').map(r => r.trim()).filter(r => r).forEach(part => {
    const colon = part.indexOf(':')
    if (colon < 1) return
    const type = part.slice(0, colon).toLowerCase()
    const ref = part.slice(colon + 1)
    if (!ref) return
    if (!activationTypeForKey(type)) {
      if (DEBUG) console.log('[DeepLink] skipping unknown ref type:', type)
      return
    }
    refs.push({ type, ref })
  })

  return refs.length ? refs : undefined
}
