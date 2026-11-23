import { describe, expect, it } from 'vitest'
import { positions } from '../src/index.js'

describe('positions', () => {
  it('leaves a config unchanged while it is a skeleton, and when turned off', () => {
    const config = { collections: [], secret: 'made-up' } as never
    expect(positions()(config)).toEqual(config)
    expect(positions({ enabled: false })(config)).toBe(config)
  })
})
