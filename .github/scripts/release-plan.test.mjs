import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readiness, trustedRun } from './release-plan.mjs'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = 'a'.repeat(40)
const repo = 'owner/repo'
const run = {
  id: 1,
  head_sha: sha,
  head_branch: 'main',
  head_repository: { full_name: repo },
  event: 'push',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
}
const proof = [{ name: 'release-ready', conclusion: 'success' }]

test('only full successful CI for the exact main commit authorizes publication', () => {
  assert.equal(readiness([run], proof, sha, repo), 'ready')
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/repo' } },
    { path: '.github/workflows/other.yml' },
  ]) {
    assert.equal(trustedRun({ ...run, ...patch }, sha, repo), false)
    assert.throws(() => readiness([{ ...run, ...patch }], proof, sha, repo))
  }
  assert.throws(() => readiness([], proof, sha, repo))
  assert.throws(() => readiness([run], [], sha, repo))
  assert.throws(() => readiness([run], [{ name: 'release-ready', conclusion: 'skipped' }], sha, repo))
  assert.throws(() => readiness([run], [...proof, { name: 'test', conclusion: 'failure' }], sha, repo))
})

test('simultaneous branch/tag pushes defer without duplicate CI; newer failures override old passes', () => {
  assert.equal(readiness([run, { ...run, id: 2, status: 'in_progress', conclusion: null }], [], sha, repo), 'pending')
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    assert.throws(() => readiness([run, { ...run, id: 2, conclusion }], proof, sha, repo))
  }
  assert.equal(readiness([{ ...run, event: 'workflow_dispatch' }], proof, sha, repo), 'ready')
})

test('release CLI handles pending CI, completion, annotated tags, reruns, moved tags and repeat events', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'actera-release-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'CI tests')
  git('config', 'user.email', 'ci@example.invalid')
  writeFileSync(join(cwd, 'README.md'), 'fixture')
  git('add', '.')
  git('commit', '-qm', 'release')
  const commit = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', commit)
  git('tag', 'v1.0.0')
  git('tag', '-a', 'v1.0.1', '-m', 'annotated')
  let current = { ...run, head_sha: commit, run_attempt: 2 }
  let jobs = proof
  let published = false
  let tagSha = commit
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url.includes('/releases/tags/')) {
      res.statusCode = published ? 200 : 404
      res.end(JSON.stringify(published ? { id: 1 } : {}))
    } else if (req.url.includes('/workflows/ci.yml/runs')) {
      res.end(JSON.stringify({ workflow_runs: [current] }))
    } else if (req.url.includes('/attempts/2/jobs')) {
      res.end(JSON.stringify({ jobs }))
    } else if (req.url.includes('/commits/')) {
      res.end(JSON.stringify({ sha: tagSha }))
    } else {
      res.statusCode = 500
      res.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  async function cli(kind, event, args = []) {
    const output = join(cwd, 'output')
    const eventPath = join(cwd, 'event.json')
    writeFileSync(output, '')
    writeFileSync(eventPath, JSON.stringify(event))
    const child = spawn(process.execPath, [fileURLToPath(new URL('./release-plan.mjs', import.meta.url)), ...args], {
      cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: kind,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repo,
        GH_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        RELEASE_TAG: 'v1.0.0',
        RELEASE_SHA: commit,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.stdout.resume()
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    return { status, stderr, output: readFileSync(output, 'utf8') }
  }
  current = { ...current, status: 'in_progress', conclusion: null }
  let result = await cli('push', { ref: 'refs/tags/v1.0.0' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.output, /publish=false/)
  assert.ok(!requests.some((path) => path.includes('/jobs')))
  current = { ...current, status: 'completed', conclusion: 'success' }
  result = await cli('workflow_run', { workflow_run: current })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.output, /publish=true/)
  assert.match(result.output, /v1.0.0/)
  assert.match(result.output, /v1.0.1/)
  assert.ok(requests.some((path) => path.includes('/attempts/2/jobs')))
  jobs = [{ name: 'release-ready', conclusion: 'skipped' }]
  assert.notEqual((await cli('push', { ref: 'refs/tags/v1.0.0' })).status, 0)
  jobs = proof
  tagSha = 'b'.repeat(40)
  assert.notEqual((await cli('push', { ref: 'refs/tags/v1.0.0' })).status, 0)
  assert.notEqual((await cli('push', {}, ['--check-tag'])).status, 0)
  tagSha = commit
  published = true
  result = await cli('push', { ref: 'refs/tags/v1.0.0' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.output, /publish=false/)
  assert.match((await cli('push', {}, ['--check-tag'])).output, /publish=false/)
})
