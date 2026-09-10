import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const dir of ['lib']) {
  rmSync(resolve(root, dir), { recursive: true, force: true })
}
