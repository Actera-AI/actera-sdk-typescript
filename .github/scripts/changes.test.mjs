import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { changedFiles, classify, lastSuccessfulBase } from './changes.mjs'

test('documentation-only changes skip the matrix', () => {
  assert.deepEqual(classify(['README.md', 'docs/setup.md']), { code: false })
})

test('source, dependencies, workflows and executable fixtures require full checks', () => {
  for (const path of [
    'src/client.ts',
    'test/client.test.ts',
    'package.json',
    'pnpm-lock.yaml',
    'contract/manifest.json',
    'CHANGELOG.md',
    'test/fixtures/input.md',
    '.github/workflows/ci.yml',
    'new-directory/input.txt',
  ]) {
    assert.deepEqual(classify([path]), { code: true }, path)
    assert.deepEqual(classify(['README.md', path]), { code: true }, path)
  }
})

test('unknown/empty ranges and manual runs fail open to full coverage', () => {
  for (const files of [null, []]) assert.ok(Object.values(classify(files)).every(Boolean))
  assert.equal(changedFiles('workflow_dispatch', {}, 'a'.repeat(40)), null)
  assert.equal(changedFiles('push', { before: '0'.repeat(40) }, 'a'.repeat(40)), null)
  assert.equal(
    changedFiles('push', { before: 'b'.repeat(40) }, 'a'.repeat(40), () => {
      throw new Error('missing')
    }),
    null,
  )
})

test('cancelled/failed pushes remain in scope until CI passes; API failures run everything', async () => {
  const success = {
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    event: 'push',
    conclusion: 'success',
    head_repository: { full_name: 'owner/repo' },
  }
  const request = async (path) => {
    assert.match(path, /branch=main&event=push&status=success/)
    return { workflow_runs: [{ ...success, conclusion: 'cancelled', head_sha: 'b'.repeat(40) }, success] }
  }
  assert.equal(await lastSuccessfulBase('owner/repo', 'ci.yml', request), success.head_sha)
  assert.equal(await lastSuccessfulBase('owner/repo', 'ci.yml', async () => ({ workflow_runs: [] })), null)
  assert.equal(
    await lastSuccessfulBase('owner/repo', 'ci.yml', async () => {
      throw new Error('403')
    }),
    null,
  )
})

test('real git history covers every pushed commit, deletion, rename and PR merge-base', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'actera-changes-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.name', 'CI tests')
  git('config', 'user.email', 'ci@example.invalid')
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'old.txt'), 'old')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  git('mv', 'src/old.txt', 'README.md')
  git('commit', '-qm', 'rename')
  writeFileSync(join(cwd, 'docs.md'), 'docs')
  git('add', '.')
  git('commit', '-qm', 'second')
  const sha = git('rev-parse', 'HEAD').trim()
  const files = changedFiles('push', { before: base }, sha, git)
  assert.deepEqual(files.sort(), ['README.md', 'docs.md', 'src/old.txt'])
  assert.equal(classify(files).code, true)
  assert.deepEqual(changedFiles('pull_request', { pull_request: { base: { sha: base } } }, sha, git).sort(), files)
})
