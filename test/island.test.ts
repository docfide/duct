import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// electron/island.cjs requires 'electron', which outside Electron is just a path string; screenMetrics doesn't use it.
const { screenMetrics } = createRequire(import.meta.url)('../electron/island.cjs') as {
  screenMetrics: (display: { bounds: { y: number }; workArea: { y: number }; internal: boolean }) => { bar: number; notch: number }
}

describe('island placement', () => {
  const display = (menuBar: number, internal = true) => ({ bounds: { y: 0 }, workArea: { y: menuBar }, internal })

  it.runIf(process.platform === 'darwin')('detects the notch from the taller menu bar on built-in displays', () => {
    expect(screenMetrics(display(38))).toEqual({ bar: 38, notch: 200 })   // 14"/16" MacBook Pro
    expect(screenMetrics(display(37))).toEqual({ bar: 37, notch: 200 })   // 13"/15" MacBook Air
    expect(screenMetrics(display(30))).toEqual({ bar: 30, notch: 0 })     // older MacBook
    expect(screenMetrics(display(25))).toEqual({ bar: 25, notch: 0 })     // classic menu bar
    expect(screenMetrics(display(38, false))).toEqual({ bar: 38, notch: 0 }) // external display
  })

  it.runIf(process.platform !== 'darwin')('uses the top edge elsewhere', () => {
    expect(screenMetrics(display(0))).toEqual({ bar: 0, notch: 0 })
  })
})
