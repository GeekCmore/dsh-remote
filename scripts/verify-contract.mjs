#!/usr/bin/env node
/**
 * verify:contract — prove the vendored seam files under packages/seams/src
 * still match their upstream sources in deepseek-ai/deepseek-harness, modulo
 * the documented adaptation points (vendored header comment + the import
 * rewrites listed in packages/seams/UPSTREAM.json).
 *
 * The pinned version/commit is read from packages/seams/UPSTREAM.json (single
 * source of truth). Upstream files are fetched raw from GitHub at the pinned
 * commit; nothing is cached. Drift fails loudly with the first differing
 * region; network failures report a clear error (exit 2), not a stack trace.
 *
 * Usage: pnpm verify:contract   (or: node scripts/verify-contract.mjs)
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seamsDir = path.join(root, 'packages', 'seams')
const spec = JSON.parse(await readFile(path.join(seamsDir, 'UPSTREAM.json'), 'utf8'))

const RAW_BASE = `https://raw.githubusercontent.com/${spec.repository}/${spec.commit}`
const FETCH_TIMEOUT_MS = 15_000

let failures = 0

function fail(local, message) {
  failures += 1
  console.error(`FAIL ${local}: ${message}`)
}

/** Strip the vendored header (the first block comment) from a local file. */
function stripHeader(text, local) {
  const match = text.match(/^\/\*\*[\s\S]*?\*\//)
  if (!match) throw new Error(`${local}: no leading vendored header comment found`)
  return { header: match[0], body: text.slice(match[0].length).replace(/^\s+/, '') }
}

/** Fetch one upstream file; returns undefined on network failure. */
async function fetchUpstream(upstreamPath) {
  const url = `${RAW_BASE}/${upstreamPath}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    console.error(`error: cannot reach ${url} (${err?.cause?.code ?? err?.message ?? err})`)
    return undefined
  }
  if (!res.ok) {
    console.error(`error: ${url} responded HTTP ${res.status}`)
    return undefined
  }
  return res.text()
}

/** Show the first differing line region between two texts. */
function firstDrift(expected, actual) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `first difference at line ${i + 1}:\n  upstream: ${JSON.stringify(a[i])}\n  vendored: ${JSON.stringify(b[i])}`
    }
  }
  return 'identical after split (line-ending difference?)'
}

/** Normalize for the shim check: drop comments, `readonly`, quotes, semicolons, whitespace. */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\breadonly\s+/g, '')
    .replace(/['"]/g, '')
    .replace(/[;\s]+/g, '')
}

/** Type-only shim check: every local export must be covered by upstream. */
function checkShim(localBody, upstreamText, local) {
  const upstreamNorm = normalize(upstreamText)
  const exports = localBody.split(/(?=^export )/m).map(s => s.trim()).filter(s => s.startsWith('export '))
  const problems = []
  for (const decl of exports) {
    const iface = decl.match(/^export\s+interface\s+(\w+)\s*\{([\s\S]*)\}/)
    if (iface) {
      const upstreamIface = upstreamText.match(new RegExp(`interface\\s+${iface[1]}\\s*\\{([\\s\\S]*?)\\n\\}`))
      if (!upstreamIface) {
        problems.push(`interface ${iface[1]} not found upstream`)
        continue
      }
      const upstreamMembers = iface[1] && normalize(upstreamIface[1])
      for (const member of iface[2].split('\n').map(l => l.trim()).filter(Boolean)) {
        const memberNorm = normalize(member)
        if (memberNorm && !upstreamMembers.includes(memberNorm)) {
          problems.push(`interface ${iface[1]} member not found upstream: ${member}`)
        }
      }
    } else if (!upstreamNorm.includes(normalize(decl))) {
      problems.push(`declaration not covered upstream: ${decl.split('\n')[0]}…`)
    }
  }
  return problems
}

for (const entry of spec.files) {
  const localPath = path.join(seamsDir, entry.local)
  const localText = await readFile(localPath, 'utf8')
  const { header, body } = stripHeader(localText, entry.local)

  // The vendored header must agree with the pinned version (shims carry no version line).
  if (!entry.shim) {
    const m = header.match(/[Uu]pstream version:?\s*([\w-]+(?:\.[\w-]+)*)/)
    if (!m) fail(entry.local, 'vendored header does not record an upstream version')
    else if (m[1] !== spec.version) fail(entry.local, `header pins ${m[1]} but UPSTREAM.json pins ${spec.version}`)
  }

  const upstreamText = await fetchUpstream(entry.upstream)
  if (upstreamText === undefined) {
    console.error(`error: verification incomplete for ${entry.local} (upstream fetch failed)`)
    process.exit(2)
  }

  if (entry.shim) {
    const problems = checkShim(body, upstreamText, entry.local)
    if (problems.length > 0) fail(entry.local, `shim drift:\n    ${problems.join('\n    ')}`)
    else console.log(`ok   ${entry.local} (type-only shim covered by ${entry.upstream})`)
    continue
  }

  let expected = upstreamText
  for (const [from, to] of entry.adapt ?? []) expected = expected.split(from).join(to)

  if (expected === body) {
    console.log(`ok   ${entry.local} == ${entry.upstream} @ ${spec.version} (modulo ${(entry.adapt ?? []).length} adaptation(s))`)
  } else {
    fail(entry.local, `drift vs ${entry.upstream} @ ${spec.version} — ${firstDrift(expected, body)}`)
  }
}

if (failures > 0) {
  console.error(`\nverify:contract FAILED — ${failures} vendored file(s) drifted from ${spec.repository} @ ${spec.version}`)
  process.exit(1)
}
console.log(`\nverify:contract OK — ${spec.files.length} vendored file(s) match ${spec.repository} @ ${spec.version} (${spec.commit.slice(0, 10)})`)
