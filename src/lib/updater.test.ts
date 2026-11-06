import { describe, expect, it } from 'vitest'

import { describeUpdateError } from './updater'

describe('更新失败的人话映射', () => {
  it('发布页缺 latest.json（v0.3.2 的真实故障）提示不是用户的问题', () => {
    const info = describeUpdateError(
      'Could not fetch a valid release JSON from the remote',
    )
    expect(info.summary).toContain('latest.json')
    expect(info.retryable).toBe(false)
    expect(info.hint).toContain('发布页')
  })

  it('404 场景也归到清单缺失', () => {
    const info = describeUpdateError('request failed: 404 Not Found releases')
    expect(info.summary).toContain('latest.json')
  })

  it('网络问题可重试', () => {
    const info = describeUpdateError('error sending request: dns error')
    expect(info.retryable).toBe(true)
    expect(info.summary).toContain('网络')
  })

  it('超时/连接失败同样可重试', () => {
    expect(describeUpdateError('operation timed out').retryable).toBe(true)
    expect(describeUpdateError('tcp connect error').retryable).toBe(true)
  })

  it('签名失败不可重试且说明已阻止安装', () => {
    const info = describeUpdateError('Minisign signature verification failed')
    expect(info.retryable).toBe(false)
    expect(info.summary).toContain('签名')
  })

  it('权限不足给出提权/覆盖安装建议', () => {
    const info = describeUpdateError('Access is denied. (os error 5)')
    expect(info.summary).toContain('权限')
    expect(info.hint).toContain('覆盖安装')
  })

  it('未知错误保留兜底并标记可重试', () => {
    const info = describeUpdateError(new Error('something odd happened'))
    expect(info.retryable).toBe(true)
    expect(info.summary).toBeTruthy()
    expect(info.hint).toBeTruthy()
  })

  it('非 Error 值也能处理', () => {
    expect(() => describeUpdateError('plain string error')).not.toThrow()
    expect(() => describeUpdateError(undefined)).not.toThrow()
  })
})
