import { defineConfig } from 'vitest/config'

// graphql is inlined with the packages that use it so the GraphQL test sees one copy of it.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false, server: { deps: { inline: [/graphql/] } } },
})
