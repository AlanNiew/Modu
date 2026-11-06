import { describe, expect, it } from 'vitest'

import { registerCommand, runCommand, unregisterAll } from './commands'

describe('命令总线', () => {
  it('注册后可执行，未注册返回 false', () => {
    expect(runCommand('test.any')).toBe(false)
    let called = 0
    const off = registerCommand('test.any', () => {
      called += 1
    })
    expect(runCommand('test.any')).toBe(true)
    expect(called).toBe(1)
    off()
    expect(runCommand('test.any')).toBe(false)
    expect(called).toBe(1)
  })

  it('注销函数不误删后来者的注册', () => {
    let firstRan = false
    let secondRan = false
    const off1 = registerCommand('test.owner', () => {
      firstRan = true
    })
    const off2 = registerCommand('test.owner', () => {
      secondRan = true
    })
    off1()
    runCommand('test.owner')
    expect(firstRan).toBe(false)
    expect(secondRan).toBe(true)
    off2()
    expect(runCommand('test.owner')).toBe(false)
  })

  it('unregisterAll 一次性清理并容忍 undefined', () => {
    let ran = 0
    const off = registerCommand('test.batch', () => {
      ran += 1
    })
    unregisterAll(undefined, off)()
    expect(runCommand('test.batch')).toBe(false)
    expect(ran).toBe(0)
  })
})
