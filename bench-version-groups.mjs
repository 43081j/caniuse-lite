/* oxlint-disable no-console */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const DIRNAME = path.dirname(fileURLToPath(import.meta.url))
const FILENAME = fileURLToPath(import.meta.url)
const AFTER_FEATURES = path.join(DIRNAME, 'data', 'features')
const BEFORE_FEATURES = path.join(
  DIRNAME,
  'node_modules',
  'caniuse-lite-prod',
  'data',
  'features'
)
const GROUPS = path.join(DIRNAME, 'data', 'versionGroups.js')

let featureFiles = fs.readdirSync(AFTER_FEATURES).filter(f => f.endsWith('.js'))

if (process.env.BENCH_MODE) {
  let after = process.env.BENCH_MODE === 'after'
  let lite = after
    ? await import(path.join(DIRNAME, 'dist', 'unpacker', 'index.js'))
    : await import('caniuse-lite-prod')
  let dir = after ? AFTER_FEATURES : BEFORE_FEATURES
  let count = Number(process.env.BENCH_FEATURES) || featureFiles.length

  global.gc()
  let baseline = process.memoryUsage().heapUsed

  // Retain the unpacked results, as a consumer holding the data would.
  let retained = []
  for (let f of featureFiles.slice(0, count)) {
    retained.push(lite.feature((await import(path.join(dir, f))).default))
  }

  global.gc()
  let used = process.memoryUsage().heapUsed - baseline
  process.stdout.write(String(used))
  if (retained.length === -1) console.log(retained) // keep alive
  process.exit(0)
}

let gzip = buf => zlib.gzipSync(buf, { level: 9 }).length
let brotli = buf =>
  zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
  }).length

function sources(dir, extra) {
  let parts = featureFiles.map(f => fs.readFileSync(path.join(dir, f)))
  if (extra) parts.push(fs.readFileSync(extra))
  return parts
}

function sizes(buffers) {
  let raw = 0
  let gzPer = 0
  let brPer = 0
  for (let buf of buffers) {
    raw += buf.length
    gzPer += gzip(buf)
    brPer += brotli(buf)
  }
  let stream = Buffer.concat(buffers)
  return { raw, gzPer, brPer, gzStream: gzip(stream), brStream: brotli(stream) }
}

let before = sizes(sources(BEFORE_FEATURES))
let after = sizes(sources(AFTER_FEATURES, GROUPS)) // after also ships the table

function spawn(env) {
  try {
    let out = execFileSync(process.execPath, ['--expose-gc', FILENAME], {
      env: { ...process.env, ...env }
    })
    return Number(out.toString().trim())
  } catch {
    return null
  }
}

let memory = (mode, count) =>
  spawn({ BENCH_MODE: mode, BENCH_FEATURES: String(count) })

let kb = n => (n / 1024).toFixed(1) + ' KB'
let pct = (b, a) => {
  let p = (1 - a / b) * 100
  return (p >= 0 ? '-' : '+') + Math.abs(p).toFixed(1) + '%'
}
let entry = (b, a) => ({ before: kb(b), after: kb(a), diff: pct(b, a) })

let groups = await import(GROUPS)
console.log(
  `\ncaniuse-lite version-groups benchmark — ${featureFiles.length} feature ` +
    `files, ${Object.keys(groups).length} interned groups`
)
console.log('before = published caniuse-lite-prod · after = this working tree')

console.log('\nSize')
console.table({
  'raw source': entry(before.raw, after.raw),
  'gzip per-file (CDN)': entry(before.gzPer, after.gzPer),
  'brotli per-file (CDN)': entry(before.brPer, after.brPer),
  'gzip stream (.tgz)': entry(before.gzStream, after.gzStream),
  'brotli stream': entry(before.brStream, after.brStream)
})

let heap = {}
let measured = true
for (let count of [1, 10, 100, featureFiles.length]) {
  let b = memory('before', count)
  let a = memory('after', count)
  if (b == null || a == null) {
    measured = false
    break
  }
  heap[`${count} feature${count === 1 ? '' : 's'}`] = entry(b, a)
}

console.log('\nRetained heap')
if (measured) console.table(heap)
else console.log('(skipped - could not re-spawn with --expose-gc)')

async function cpuBench() {
  let { Bench } = await import('tinybench')
  let liteBefore = await import('caniuse-lite-prod')
  let liteAfter = await import(path.join(DIRNAME, 'dist', 'unpacker', 'index.js'))
  let load = dir => Promise.all(featureFiles.map(async f => {
    let mod = await import(path.join(dir, f));
    return mod.default;
  }));
  let packedBefore = await load(BEFORE_FEATURES)
  let packedAfter = await load(AFTER_FEATURES)

  let bench = new Bench({ time: 500 })
  bench.add('before', () => {
    for (let data of packedBefore) liteBefore.feature(data)
  })
  bench.add('after', () => {
    for (let data of packedAfter) liteAfter.feature(data)
  })
  await bench.run()

  console.log('\nCPU (load all features)')
  console.table(bench.table())
}

await cpuBench();

if (process.env.BENCH_KEEPALIVE) {
  setInterval(() => {}, 20_000)
}
