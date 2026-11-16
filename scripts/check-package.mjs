import { inspectText } from './check-publication.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const sdk = root
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(manifest.license, 'Apache-2.0')
assert.equal(manifest.private, undefined, 'A private package cannot be published to npm later')
assert.equal(manifest.publishConfig?.access, 'public')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'actera-sdk-package-'))
const consumer = path.join(scratch, 'consumer')
const installed = (...parts) => path.join(consumer, 'node_modules', ...manifest.name.split('/'), ...parts)
// Run the npm bundled with the current Node.js through Node itself, so no shell
// is involved and the consumer install does not inherit the developer's or
// package manager's npm_config_* environment.
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npm = fs.existsSync(npmCli) ? npmCli : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)))

function run(command, args, cwd) {
  const viaNode = command === npmCli
  const result = spawnSync(viaNode ? process.execPath : command, viaNode ? [npmCli, ...args] : args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: !viaNode && process.platform === 'win32' && command === npm,
    maxBuffer: 8 << 20,
  })
  if (result.status !== 0)
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

try {
  fs.mkdirSync(consumer)
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], sdk))[0]
  const names = packed.files.map((file) => file.path).sort()
  const expected = [
    'README.md',
    'LICENSE',
    'NOTICE',
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/execution.js',
    'dist/execution.d.ts',
    'dist/generated/schema.js',
    'dist/generated/schema.d.ts',
    'dist/mcp/index.js',
    'dist/mcp/index.d.ts',
    'dist/mcp/node.js',
    'dist/mcp/node.d.ts',
  ].sort()
  assert.deepEqual(names, expected, 'SDK package contents changed; review them before distribution')
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    '{"name":"actera-package-check","private":true,"type":"module"}\n',
  )
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(scratch, packed.filename),
      'typescript@5.9.3',
      '@types/node@24.10.1',
    ],
    consumer,
  )
  for (const file of names) {
    const bytes = fs.readFileSync(installed(file))
    assert.equal(inspectText(bytes.toString('utf8')), null, `Restricted content in packed file: ${file}`)
  }
  const shippedSchema = fs.readFileSync(installed('dist', 'generated', 'schema.d.ts'), 'utf8')
  assert.match(shippedSchema, /"\/v1\/decisions"/)
  assert.match(shippedSchema, /DecisionIngestionService_CreateDecision/)
  assert.match(shippedSchema, /ExecutionService_ReportActionExecution/)
  assert.match(shippedSchema, /v1CustomerDecision/)
  assert.match(shippedSchema, /v1CustomerActionIntent/)
  assert.ok(shippedSchema.length < 80_000, 'SDK wire declarations expanded; review the release surface')
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "for (const entry of ['@actera-ai/sdk', '@actera-ai/sdk/execution', '@actera-ai/sdk/mcp', '@actera-ai/sdk/mcp/node']) await import(entry)",
    ],
    consumer,
  )
  fs.writeFileSync(
    path.join(consumer, 'types.mts'),
    "import { ActeraClient } from '@actera-ai/sdk'\nimport { ActeraExecution } from '@actera-ai/sdk/execution'\nimport { createActeraMcpContinuation } from '@actera-ai/sdk/mcp'\nimport { createInvocationContext } from '@actera-ai/sdk/mcp/node'\nvoid [ActeraClient, ActeraExecution, createActeraMcpContinuation, createInvocationContext]\n",
  )
  run(
    process.execPath,
    [
      path.join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      path.join(consumer, 'types.mts'),
    ],
    consumer,
  )
  console.log(`SDK package passed isolated runtime and type checks (${names.length} reviewed files)`)
} finally {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!path.resolve(scratch).startsWith(tempRoot)) throw new Error('Refusing to remove unexpected package-check path')
  fs.rmSync(scratch, { recursive: true, force: true })
}
