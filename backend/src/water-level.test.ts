import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyWaterLevel } from './water-level.js'

const thresholds = { lowMaxPct: 30, normalMaxPct: 70, highMaxPct: 90 }

test('classifies calibrated percentage boundaries', () => {
  assert.equal(classifyWaterLevel(0, thresholds), 'LOW')
  assert.equal(classifyWaterLevel(30, thresholds), 'LOW')
  assert.equal(classifyWaterLevel(30.1, thresholds), 'NORMAL')
  assert.equal(classifyWaterLevel(70, thresholds), 'NORMAL')
  assert.equal(classifyWaterLevel(70.1, thresholds), 'HIGH')
  assert.equal(classifyWaterLevel(90, thresholds), 'HIGH')
  assert.equal(classifyWaterLevel(90.1, thresholds), 'CRITICAL')
  assert.equal(classifyWaterLevel(100, thresholds), 'CRITICAL')
})

test('does not classify missing calibration or missing level as measured status', () => {
  assert.equal(classifyWaterLevel(50, null), 'UNCONFIGURED')
  assert.equal(classifyWaterLevel(null, thresholds), 'UNCONFIGURED')
  assert.equal(classifyWaterLevel(50, { lowMaxPct: null, normalMaxPct: null, highMaxPct: null }), 'UNCONFIGURED')
})
