import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { installLiveRuntime, installLiveRuntimeGroup } from '../src/index.js'

const target = (targetId: string) => ({
  targetId,
  host: `${targetId}.example`,
  username: 'deploy',
  auth: { type: 'agent' as const },
})

describe('installLiveRuntimeGroup', () => {
  it('shares one execution stack and enforces one active target', async () => {
    const ctx = new Context()
    const group = installLiveRuntimeGroup(ctx, [target('prod'), target('stage')], 'stage')

    expect(group.activeTargetId).toBe('stage')
    expect(group.runtimes).toHaveLength(2)
    expect(group.get('prod')?.fs).toBe(group.get('stage')?.fs)
    expect(group.get('prod')?.subprocess).toBe(group.get('stage')?.subprocess)
    await expect(group.get('prod')?.connect()).rejects.toThrow('remote target prod is not active')

    group.activate('prod')
    expect(group.activeTargetId).toBe('prod')
  })

  it('keeps the single-target installer compatible', () => {
    const runtime = installLiveRuntime(new Context(), target('default'))
    expect(runtime.targetId).toBe('default')
    expect(runtime.status).toBe('disconnected')
  })

  it('rejects empty, duplicate, and unknown active target configurations', () => {
    expect(() => installLiveRuntimeGroup(new Context(), [])).toThrow('at least one target')
    expect(() => installLiveRuntimeGroup(new Context(), [target('same'), target('same')])).toThrow('duplicate target id')
    expect(() => installLiveRuntimeGroup(new Context(), [target('prod')], 'missing')).toThrow('unknown initial target')
  })
})
