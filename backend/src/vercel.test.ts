import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeApiPath } from './vercel-path.js'

test('normalizes Vercel function paths to the Express API prefix', () => {
  const request = { url: '/auth/session?source=web' }

  normalizeApiPath(request)

  assert.equal(request.url, '/api/auth/session?source=web')
})

test('does not double-prefix API paths', () => {
  const request = { url: '/api/auth/session' }

  normalizeApiPath(request)

  assert.equal(request.url, '/api/auth/session')
})
