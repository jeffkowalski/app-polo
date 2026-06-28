// Copyright ©️ 2026 Sebastian Delmont <sd@ham2k.com>
// SPDX-License-Identifier: MPL-2.0

import { buildSuggestedQSO, findOrCreateOperation } from './DeepLinkUtils'

jest.mock('./extensions/registry', () => ({
  findHooks: (category, { key } = {}) => {
    if (category !== 'activity') return []
    const hooks = [
      { key: 'sota', activationType: 'sotaActivation', huntingType: 'sota' },
      { key: 'pota', activationType: 'potaActivation', huntingType: 'pota' },
      { key: 'wwff', activationType: 'wwffActivation', huntingType: 'wwff' },
      { key: 'gma', activationType: 'gmaActivation', huntingType: 'gma' },
      { key: 'wca', activationType: 'wcaActivation', huntingType: 'wca' },
      { key: 'zlota', activationType: 'zlotaActivation', huntingType: 'zlota' }
    ]
    return key ? hooks.filter(h => h.key === key) : hooks
  }
}))

jest.mock('@ham2k/lib-operation-data', () => ({
  bandForFrequency: (freq) => {
    if (freq >= 14000 && freq < 14350) return '20m'
    if (freq >= 7000 && freq < 7300) return '40m'
    return undefined
  },
  modeForFrequency: (freq) => (freq < 14100 ? 'CW' : 'SSB')
}))

jest.mock('./store/operations', () => ({
  selectLatestOperation: () => ({ uuid: 'latest-op' }),
  selectAllOperations: (state) => state,
  addNewOperation: (operation) => async () => ({ uuid: 'new-op-uuid', ...operation }),
  setOperationData: (data) => async () => data
}))

describe('buildSuggestedQSO', () => {
  it('parses a chase QSO with their.refs and Hz frequency', () => {
    const { qso, ourRefs } = buildSuggestedQSO(
      { 'their.call': 'k6test', 'their.refs': 'sota:W6/CT-006', frequency: '14285000', mode: 'cw' },
      'com.ham2k://qso'
    )
    expect(qso.their.call).toBe('K6TEST')
    expect(qso.freq).toBe(14285)
    expect(qso.band).toBe('20m')
    expect(qso.mode).toBe('CW')
    expect(qso.refs).toEqual([{ type: 'sota', ref: 'W6/CT-006' }])
    expect(ourRefs).toBeUndefined()
  })

  it('accepts freq in kHz when frequency (Hz) is absent', () => {
    const { qso } = buildSuggestedQSO({ freq: '7185', 'their.call': 'ki2d' }, 'url')
    expect(qso.freq).toBe(7185)
    expect(qso.band).toBe('40m')
  })

  it('leaves mode undefined when omitted (no crash)', () => {
    const { qso } = buildSuggestedQSO({ 'their.call': 'ki2d' }, 'url')
    expect(qso.mode).toBeUndefined()
  })

  it('skips unknown ref types (lenient)', () => {
    const { qso } = buildSuggestedQSO({ 'their.refs': 'iota:NA-001,pota:US-1234' }, 'url')
    expect(qso.refs).toEqual([{ type: 'pota', ref: 'US-1234' }])
  })

  it('routes our.refs to ourRefs, not onto the QSO', () => {
    const { qso, ourRefs } = buildSuggestedQSO({ 'our.refs': 'sota:W6/CT-006' }, 'url')
    expect(ourRefs).toEqual([{ type: 'sota', ref: 'W6/CT-006' }])
    expect(qso.refs).toBeUndefined()
  })

  it('uppercases their.call, preserving a portable suffix and a multi-op list', () => {
    const { qso } = buildSuggestedQSO({ 'their.call': 'ki2d,s5/kc6x/p' }, 'url')
    expect(qso.their.call).toBe('KI2D,S5/KC6X/P')
  })

  it('ignores our.call (not read; the operation supplies our station)', () => {
    const { qso } = buildSuggestedQSO({ 'our.call': 'kc6x', 'their.call': 'ki2d' }, 'url')
    expect(qso.our).toBeUndefined()
  })

  describe('multiple references (n-fer activations)', () => {
    it('maps multiple their.refs across programs (park + summit) onto the QSO', () => {
      const { qso } = buildSuggestedQSO({ 'their.refs': 'pota:US-1234,sota:W6/CT-006' }, 'url')
      expect(qso.refs).toEqual([
        { type: 'pota', ref: 'US-1234' },
        { type: 'sota', ref: 'W6/CT-006' }
      ])
    })

    it('keeps several parks of the same program for an n-fer chase', () => {
      const { qso } = buildSuggestedQSO({ 'their.refs': 'pota:US-1234,pota:US-5678' }, 'url')
      expect(qso.refs).toEqual([
        { type: 'pota', ref: 'US-1234' },
        { type: 'pota', ref: 'US-5678' }
      ])
    })

    it('routes multiple our.refs (our own n-fer) into ourRefs, not onto the QSO', () => {
      const { qso, ourRefs } = buildSuggestedQSO({ 'our.refs': 'pota:US-1234,sota:W6/CT-006' }, 'url')
      expect(ourRefs).toEqual([
        { type: 'pota', ref: 'US-1234' },
        { type: 'sota', ref: 'W6/CT-006' }
      ])
      expect(qso.refs).toBeUndefined()
    })

    it('keeps only the valid refs when an n-fer list mixes known and unknown types', () => {
      const { qso, ourRefs } = buildSuggestedQSO(
        { 'their.refs': 'pota:US-1234,iota:NA-001,sota:W6/CT-006', 'our.refs': 'wwff:KFF-1234,iota:NA-002,pota:US-5678' },
        'url'
      )
      expect(qso.refs).toEqual([
        { type: 'pota', ref: 'US-1234' },
        { type: 'sota', ref: 'W6/CT-006' }
      ])
      expect(ourRefs).toEqual([
        { type: 'wwff', ref: 'KFF-1234' },
        { type: 'pota', ref: 'US-5678' }
      ])
    })
  })
})

describe('findOrCreateOperation', () => {
  const dispatch = jest.fn(async (action) => (typeof action === 'function' ? action(dispatch, () => ({})) : action))
  beforeEach(() => dispatch.mockClear())

  const ourRefs = [{ type: 'sota', ref: 'W6/CT-006' }]

  it('reuses a recent operation activating a matching ref', async () => {
    const recent = { uuid: 'op-1', createdAtMillis: Date.now(), refs: [{ type: 'sotaActivation', ref: 'W6/CT-006' }] }
    const op = await findOrCreateOperation({ ourRefs, operations: { 'op-1': recent }, dispatch })
    expect(op.uuid).toBe('op-1')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ignores stale operations (older than 24h) and creates a new one', async () => {
    const stale = { uuid: 'op-old', createdAtMillis: Date.now() - 25 * 60 * 60 * 1000, refs: [{ type: 'sotaActivation', ref: 'W6/CT-006' }] }
    const op = await findOrCreateOperation({ ourRefs, operations: { 'op-old': stale }, dispatch })
    expect(op.uuid).toBe('new-op-uuid')
    expect(op.refs).toEqual([{ type: 'sotaActivation', ref: 'W6/CT-006' }])
  })

  it('creates a new activation operation when none match', async () => {
    const op = await findOrCreateOperation({ ourRefs, operations: {}, dispatch })
    expect(op.uuid).toBe('new-op-uuid')
    expect(op.refs).toEqual([{ type: 'sotaActivation', ref: 'W6/CT-006' }])
  })

  describe('our operation covering more than one reference (n-fer)', () => {
    const multiRefs = [{ type: 'pota', ref: 'US-1234' }, { type: 'sota', ref: 'W6/CT-006' }]
    const recentOp = (refs) => ({ uuid: 'op-multi', createdAtMillis: Date.now(), refs })

    it('reuses an operation whose refs are exactly the requested set (any order)', async () => {
      const recent = recentOp([
        { type: 'sotaActivation', ref: 'W6/CT-006' },
        { type: 'potaActivation', ref: 'US-1234' }
      ])
      const op = await findOrCreateOperation({ ourRefs: multiRefs, operations: { 'op-multi': recent }, dispatch })
      expect(op.uuid).toBe('op-multi')
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('creates a new operation carrying every our.ref as an activation', async () => {
      const op = await findOrCreateOperation({ ourRefs: multiRefs, operations: {}, dispatch })
      expect(op.uuid).toBe('new-op-uuid')
      expect(op.refs).toEqual([
        { type: 'potaActivation', ref: 'US-1234' },
        { type: 'sotaActivation', ref: 'W6/CT-006' }
      ])
    })

    it('does NOT reuse an operation activating only some of the requested refs', async () => {
      // op is a summit-only activation; the request is park + summit, different activation
      const recent = recentOp([{ type: 'sotaActivation', ref: 'W6/CT-006' }])
      const op = await findOrCreateOperation({ ourRefs: multiRefs, operations: { 'op-multi': recent }, dispatch })
      expect(op.uuid).toBe('new-op-uuid')
    })

    it('does NOT reuse a multi-ref operation for a single-ref request (a park without the summit)', async () => {
      // activating just the park must not grab the park+summit n-fer operation
      const recent = recentOp([
        { type: 'potaActivation', ref: 'US-1234' },
        { type: 'sotaActivation', ref: 'W6/CT-006' }
      ])
      const op = await findOrCreateOperation({ ourRefs: [{ type: 'pota', ref: 'US-1234' }], operations: { 'op-multi': recent }, dispatch })
      expect(op.uuid).toBe('new-op-uuid')
      expect(op.refs).toEqual([{ type: 'potaActivation', ref: 'US-1234' }])
    })
  })
})
