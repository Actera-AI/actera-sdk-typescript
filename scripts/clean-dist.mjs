import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sdkRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = path.resolve(sdkRoot, 'dist')
if (path.dirname(output) !== sdkRoot) throw new Error('Build output escaped the SDK directory')
if (fs.existsSync(output)) {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Refusing to replace a linked build output')
  fs.rmSync(output, { recursive: true, force: true })
}
