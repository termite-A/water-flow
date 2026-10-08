import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeApiPath } from './vercel-path.js'

test('normalizes Vercel function paths to the Express API prefix', () => {
  const request = { url: '/auth/session?source=web' }

  normalizeApiPath(request)

  assert.equal(request.url, '/api/auth/session?source=web')
})

test('restores the original API route and query parameters after a Vercel rewrite', () => {
  const request = { url: '/api/index?path=devices%2Fcommands&deviceId=waterflow-001' }

  normalizeApiPath(request)

  assert.equal(request.url, '/api/devices/commands?deviceId=waterflow-001')
})

test('does not double-prefix API paths', () => {
  const request = { url: '/api/auth/session' }

  normalizeApiPath(request)

  assert.equal(request.url, '/api/auth/session')
})
