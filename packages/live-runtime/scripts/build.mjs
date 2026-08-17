import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(packageRoot, '..')

await mkdir(resolve(packageRoot, 'dist'), { recursive: true })
await build({
  entryPoints: [resolve(packageRoot, 'src/index.ts')],
  outfile: resolve(packageRoot, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  treeShaking: true,
  external: ['@deepseek-ai/cordis', 'ssh2'],
  alias: {
    '@dsh-remote/remote': resolve(packagesRoot, 'remote/src/index.ts'),
    '@dsh-remote/seams': resolve(packagesRoot, 'seams/src/index.ts'),
  },
})
await copyFile(resolve(packageRoot, 'types/index.d.ts'), resolve(packageRoot, 'dist/index.d.ts'))
