#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const YAML = require('yaml')
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']
const DEFAULT_CONFIG = 'gidas-alignment.config.json'
const REQ_TOKEN = /\bREQ-[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\b/g

run()

function run() {
  const args = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()
  const cfgPath = path.resolve(cwd, args.config || DEFAULT_CONFIG)
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const outDir = path.resolve(cwd, args.outputDir || cfg.outputDir || '.gidas/alignment')
  fs.mkdirSync(outDir, { recursive: true })

  const selfFiles = {
    index: path.resolve(cwd, 'index.html'),
    openapi: exists(path.resolve(cwd, 'openapi.yaml')) ? path.resolve(cwd, 'openapi.yaml') : null,
    agents: exists(path.resolve(cwd, 'AGENTS.md')) ? path.resolve(cwd, 'AGENTS.md') : null,
  }
  if (!exists(selfFiles.index)) throw new Error('Missing ./index.html')

  const selfIndex = makeSpecIndex({
    specId: must(cfg.self?.specId, 'self.specId'),
    repo: must(cfg.self?.repo, 'self.repo'),
    homeUrl: must(cfg.self?.homeUrl, 'self.homeUrl'),
    files: selfFiles,
  })

  const peerIndexes = []
  const missingPeers = []
  for (const peer of cfg.peers || []) {
    const files = resolvePeer(peer, cwd)
    if (!files.index) {
      missingPeers.push({
        spec_id: peer.specId || 'UNSPECIFIED',
        repo: peer.repo || 'UNSPECIFIED',
        missing: 'index.html',
        attempted_paths: (peer.localSnapshotPaths || []).map((p) => path.resolve(cwd, p)),
      })
      continue
    }
    peerIndexes.push(
      makeSpecIndex({
        specId: must(peer.specId, 'peer.specId'),
        repo: must(peer.repo, `peer(${peer.specId}).repo`),
        homeUrl: must(peer.homeUrl, `peer(${peer.specId}).homeUrl`),
        files,
      }),
    )
  }

  writeJson(path.join(outDir, 'spec-index.self.json'), selfIndex)
  writeJson(path.join(outDir, 'spec-index.peers.json'), peerIndexes)

  if (missingPeers.length) {
    writeJson(path.join(outDir, 'cross-spec-map.json'), {
      generated_at: new Date().toISOString(),
      self_spec_id: selfIndex.spec_id,
      canonical_terms: [],
      canonical_clauses: [],
      conflicts: [],
      gaps: [],
      status: 'peer-snapshots-missing',
      missing_peers: missingPeers,
    })
    fs.writeFileSync(path.join(outDir, 'alignment-report.md'), renderMissingReport(missingPeers), 'utf8')
    writePatch(path.join(outDir, 'proposed-changes.patch'))
    process.exit(1)
  }

  const map = makeCrossMap([selfIndex, ...peerIndexes], selfIndex.spec_id)
  writeJson(path.join(outDir, 'cross-spec-map.json'), map)
  fs.writeFileSync(path.join(outDir, 'alignment-report.md'), renderReport(selfIndex, peerIndexes, map), 'utf8')
  writePatch(path.join(outDir, 'proposed-changes.patch'))

  console.log(
    [
      `Self: ${selfIndex.spec_id}`,
      `Peers indexed: ${peerIndexes.length}`,
      `Term clusters: ${map.canonical_terms.length}`,
      `Clause clusters: ${map.canonical_clauses.length}`,
      `Conflicts: ${map.conflicts.length}`,
      `Gaps: ${map.gaps.length}`,
      `Artifacts: ${outDir}`,
    ].join('\n'),
  )
}

function parseArgs(args) {
  const out = { config: DEFAULT_CONFIG, outputDir: null }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config') out.config = args[++i]
    if (args[i] === '--output-dir') out.outputDir = args[++i]
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(
        'Usage: node scripts/cross-spec-align.mjs [--config gidas-alignment.config.json] [--output-dir .gidas/alignment]',
      )
      process.exit(0)
    }
  }
  return out
}

function resolvePeer(peer, cwd) {
  const candidates = []
  for (const p of peer.localSnapshotPaths || []) {
    const abs = path.resolve(cwd, p)
    candidates.push(abs)
    if (exists(abs) && fs.statSync(abs).isDirectory()) {
      candidates.push(path.join(abs, 'index.html'))
      candidates.push(path.join(abs, 'openapi.yaml'))
    }
  }
  let index = null
  let openapi = null
  for (const file of candidates) {
    if (!exists(file) || !fs.statSync(file).isFile()) continue
    const n = path.basename(file).toLowerCase()
    if (n === 'index.html' && !index) index = file
    if (n === 'openapi.yaml' && !openapi) openapi = file
  }
  return { index, openapi, agents: null }
}

function makeSpecIndex({ specId, repo, homeUrl, files }) {
  const html = fs.readFileSync(files.index, 'utf8')
  const terms = extractTerms(html)
  const clauses = extractClauses(html)
  const reqRefs = reqTokens(html)
  const termRefs = uniq(
    Array.from(html.matchAll(/\[=([^=\]]+)=\]/g), (m) => clean(m[1] || '')).filter(Boolean),
  )
  const xrefs = extractXrefs(html)
  const openapi = files.openapi ? extractOpenapi(files.openapi) : null
  return {
    spec_id: specId,
    repo,
    home_url: homeUrl,
    commit_or_version: detectCommitOrVersion(files.index, openapi?.info_version),
    files: {
      index_html: files.index,
      openapi_yaml: files.openapi,
      agents_md: files.agents,
    },
    terms,
    clauses,
    term_references: termRefs,
    requirement_references: reqRefs,
    cross_spec_references: xrefs,
    openapi,
  }
}

function extractTerms(html) {
  const sections = Array.from(
    html.matchAll(/<section\b[^>]*\bid=(["'])([^"']+)\1[^>]*>/gi),
    (m) => ({ i: m.index ?? 0, id: m[2] }),
  )
  const terms = []
  for (const m of html.matchAll(/<dfn\b([^>]*)>([\s\S]*?)<\/dfn>/gi)) {
    const attrs = attrsToMap(m[1] || '')
    const term = clean(m[2] || '')
    if (!term) continue
    const i = m.index ?? 0
    const sec = nearestSection(sections, i)
    const after = html.slice(i + m[0].length, i + m[0].length + 1400)
    const dd = /^\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/i.exec(after)
    const def = dd ? clean(dd[1]) : ''
    terms.push({
      term_text: term,
      term_id: attrs.id || slug(term),
      anchor: `#${attrs.id || slug(term)}`,
      section_anchor: sec ? `#${sec}` : null,
      definition_excerpt_hash: def ? hash(canon(def)) : null,
      definition_text_excerpt: cut(def, 280),
    })
  }
  return terms
}

function extractClauses(html) {
  const rows = []
  const seen = new Set()
  for (const m of html.matchAll(/\bid=(["'])([^"']+)\1/gi)) {
    const id = m[2]
    const at = m.index ?? 0
    const text = clean(html.slice(Math.max(0, at - 120), at + 1200))
    const req = (text.match(REQ_TOKEN) || [null])[0]
    if (!req && !id.toLowerCase().startsWith('req-')) continue
    const clauseId = req || id.toUpperCase()
    const k = `${clauseId}|${id}`
    if (seen.has(k)) continue
    seen.add(k)
    rows.push({
      clause_id: clauseId,
      anchor: `#${id}`,
      kind: req ? 'requirement' : /algorithm/i.test(id + text) ? 'algorithm' : 'invariant',
      normative_keywords_used: extractNormative(text),
      text_excerpt_hash: hash(canon(text)),
      text_excerpt: cut(text, 360),
    })
  }
  return rows
}

function extractXrefs(html) {
  const refs = []
  for (const m of html.matchAll(
    /<a\b[^>]*href=(["'])(https?:\/\/z-base\.github\.io\/(gdis|gqscd|gqts)\/?[^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    refs.push({
      kind: 'href',
      target_spec_id: m[3].toLowerCase() === 'gdis' ? 'GDIS-CORE' : m[3].toLowerCase() === 'gqscd' ? 'GQSCD-CORE' : 'GQTS-CORE',
      href: m[2],
      label: clean(m[4] || ''),
    })
  }
  for (const m of html.matchAll(/\[(GDIS-CORE|GQSCD-CORE|GQTS-CORE)\]/g)) {
    refs.push({ kind: 'label', target_spec_id: m[1], href: null, label: m[1] })
  }
  return refs
}

function extractOpenapi(file) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  const requirementSets = []
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('x-') && /requirements$/i.test(k) && plain(v)) {
      requirementSets.push({
        extension: k,
        entries: Object.entries(v).map(([id, desc]) => ({ requirement_id: id, description: String(desc) })),
      })
    }
  }
  const operations = []
  for (const [p, item] of Object.entries(doc.paths || {})) {
    if (!plain(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (!plain(op)) continue
      const reqExt = Object.keys(op).find((k) => k.startsWith('x-') && /requirement$/i.test(k))
      const reqId = reqExt && typeof op[reqExt] === 'string' ? op[reqExt] : null
      const reqMedia = Object.keys(op.requestBody?.content || {}).sort()
      const reqSchema = collectSchemaRefsFromContent(op.requestBody?.content || {}).sort()
      const resMedia = new Set()
      const resSchema = new Set()
      for (const resp of Object.values(op.responses || {})) {
        if (!plain(resp?.content)) continue
        for (const [mt, media] of Object.entries(resp.content)) {
          resMedia.add(mt)
          for (const r of collectSchemaRefs(media?.schema)) resSchema.add(r)
        }
      }
      const contract = {
        method: method.toUpperCase(),
        path: p,
        operation_id: op.operationId || null,
        requirement_id: reqId,
        request_media_types: reqMedia,
        request_schema_pointers: reqSchema,
        response_media_types: Array.from(resMedia).sort(),
        response_schema_pointers: Array.from(resSchema).sort(),
      }
      operations.push({ ...contract, contract_hash: hash(stable(contract)) })
    }
  }
  const schemas = Object.entries(doc.components?.schemas || {}).map(([name, schema]) => ({
    name,
    json_pointer: `#/components/schemas/${name}`,
    key_constraints_hash: hash(stable(schema)),
  }))
  return { info_version: doc.info?.version || 'unspecified', requirement_sets: requirementSets, operations, schemas }
}

function makeCrossMap(specs, selfSpecId) {
  const terms = []
  for (const s of specs) {
    for (const t of s.terms || []) terms.push({ ...t, spec_id: s.spec_id, n: normalize(t.term_text) })
  }
  const byNorm = group(terms, (t) => t.n)
  const canonicalTerms = []
  const conflicts = []
  for (const [n, members] of byNorm.entries()) {
    const owner = chooseTermOwner(n, members)
    const cm = members.find((m) => m.spec_id === owner) || members[0]
    const defs = uniq(members.map((m) => m.definition_excerpt_hash).filter(Boolean))
    if (defs.length > 1) conflicts.push({ kind: 'term-definition-conflict', normalized_term: n, member_specs: uniq(members.map((m) => m.spec_id)), definition_hashes: defs })
    canonicalTerms.push({
      canonical_term: cm.term_text,
      canonical_owner_spec_id: owner,
      canonical_anchor: cm.anchor,
      aliases: uniq(members.map((m) => m.term_text).filter((x) => x !== cm.term_text)),
      members: members.map((m) => ({ spec_id: m.spec_id, term_text: m.term_text, term_id: m.term_id, anchor: m.anchor, definition_hash: m.definition_excerpt_hash })),
    })
  }

  const opRows = []
  for (const s of specs) for (const op of s.openapi?.operations || []) opRows.push({ spec_id: s.spec_id, ...op })
  const byConcept = group(opRows, (o) => o.operation_id || `${o.method} ${o.path}`)
  const canonicalClauses = []
  for (const [concept, members] of byConcept.entries()) {
    const owner = members.some((m) => m.path.includes('/gqts/')) ? 'GQTS-CORE' : members[0].spec_id
    const own = members.find((m) => m.spec_id === owner) || members[0]
    const reqIds = uniq(members.map((m) => m.requirement_id).filter(Boolean))
    const contracts = uniq(members.map((m) => m.contract_hash))
    if (members.length > 1 && reqIds.length > 1) conflicts.push({ kind: 'requirement-id-namespace-conflict', clause_concept: concept, member_specs: uniq(members.map((m) => m.spec_id)), requirement_ids: reqIds })
    if (members.length > 1 && contracts.length > 1) conflicts.push({ kind: 'operation-contract-conflict', clause_concept: concept, member_specs: uniq(members.map((m) => m.spec_id)) })
    canonicalClauses.push({
      clause_concept: concept,
      canonical_owner_spec_id: owner,
      canonical_clause_id: own.requirement_id || 'UNSPECIFIED',
      member_clause_ids: members.map((m) => ({ spec_id: m.spec_id, requirement_id: m.requirement_id || null, method: m.method, path: m.path })),
    })
  }

  const defined = new Set(terms.map((t) => t.n))
  const gaps = []
  for (const s of specs) {
    const clauseSet = new Set((s.clauses || []).map((c) => c.clause_id))
    for (const tr of s.term_references || []) if (!defined.has(normalize(tr))) gaps.push({ type: 'undefined-term', spec_id: s.spec_id, term_reference: tr })
    for (const rr of s.requirement_references || []) if (!clauseSet.has(rr)) gaps.push({ type: 'unanchored-requirement-reference', spec_id: s.spec_id, requirement_id: rr })
  }

  return {
    generated_at: new Date().toISOString(),
    self_spec_id: selfSpecId,
    canonical_terms: canonicalTerms.sort((a, b) => a.canonical_term.localeCompare(b.canonical_term, 'en')),
    canonical_clauses: canonicalClauses.sort((a, b) => a.clause_concept.localeCompare(b.clause_concept, 'en')),
    conflicts,
    gaps,
  }
}

function chooseTermOwner(norm, members) {
  const corpus = members.map((m) => `${m.term_text} ${m.definition_text_excerpt || ''}`.toLowerCase()).join(' ')
  const hit = (arr) => arr.reduce((n, k) => n + (corpus.includes(k) ? 1 : 0), 0)
  const score = {
    'GQSCD-CORE': hit(['device', 'controller', 'signature creation', 'hardware', 'attestation', 'intent']),
    'GDIS-CORE': hit(['identity', 'pid', 'binding', 'issuance', 'attribute', 'identification', 'mrz']),
    'GQTS-CORE': hit(['event', 'log', 'replication', 'scheme', 'service descriptor', 'gossip', 'publication']),
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1])
  if (ranked[0][1] > 0 && members.some((m) => m.spec_id === ranked[0][0])) return ranked[0][0]
  return uniq(members.map((m) => m.spec_id)).sort()[0]
}

function renderReport(selfIndex, peerIndexes, map) {
  const l = []
  l.push('# Alignment Report', '')
  l.push(`Generated: ${new Date().toISOString()}`)
  l.push(`Self spec: ${selfIndex.spec_id}`)
  l.push(`Peer specs loaded: ${peerIndexes.map((p) => p.spec_id).join(', ') || 'none'}`, '')
  l.push('## What Changed', '- No in-place spec edits were applied.', '')
  l.push('## Duplicates Removed', '- None (analysis-only run).', '')
  l.push('## Cross-References Added', '- None (analysis-only run).', '')
  l.push('## Key Conflicts')
  if (!map.conflicts.length) l.push('- None.')
  else for (const c of map.conflicts) l.push(`- ${c.kind}: ${JSON.stringify(c)}`)
  l.push('', '## Remaining Gaps (UNSPECIFIED/TODO)')
  if (!map.gaps.length) l.push('- None.')
  else for (const g of map.gaps) l.push(`- ${g.type}: ${JSON.stringify(g)}`)
  l.push('', '## Output Files', '- spec-index.self.json', '- spec-index.peers.json', '- cross-spec-map.json', '- alignment-report.md', '- proposed-changes.patch', '')
  return l.join('\n')
}

function renderMissingReport(missingPeers) {
  const l = ['# Alignment Report', '', 'Status: FAILED (missing peer snapshots)', '', '## Missing Inputs']
  for (const p of missingPeers) l.push(`- ${p.spec_id} (${p.repo}): ${p.missing}. Attempted: ${p.attempted_paths.join(', ') || 'none'}`)
  l.push('', '## Required Action', '- Provide local peer snapshots in `localSnapshotPaths` and rerun.', '')
  return l.join('\n')
}

function writePatch(file) {
  let patch = ''
  try {
    patch = execSync('git diff -- index.html openapi.yaml', { encoding: 'utf8' })
  } catch (error) {
    const code = error?.code ? String(error.code) : 'unknown'
    patch = `# Unable to generate git diff in this runtime (${code}).\n`
  }
  if (!patch.trim()) patch = '# No spec changes were applied by the alignment runner.\n'
  fs.writeFileSync(file, patch, 'utf8')
}

function reqTokens(text) {
  return uniq(Array.from(text.matchAll(REQ_TOKEN), (m) => m[0]))
}

function collectSchemaRefsFromContent(content) {
  const out = new Set()
  for (const v of Object.values(content || {})) for (const r of collectSchemaRefs(v?.schema)) out.add(r)
  return Array.from(out)
}

function collectSchemaRefs(schema, out = new Set(), depth = 0) {
  if (!schema || depth > 32) return Array.from(out)
  if (Array.isArray(schema)) {
    for (const v of schema) collectSchemaRefs(v, out, depth + 1)
    return Array.from(out)
  }
  if (!plain(schema)) return Array.from(out)
  if (typeof schema.$ref === 'string') out.add(schema.$ref)
  for (const v of Object.values(schema)) collectSchemaRefs(v, out, depth + 1)
  return Array.from(out)
}

function attrsToMap(src) {
  const m = {}
  for (const x of src.matchAll(/([a-zA-Z_:-][a-zA-Z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) m[x[1]] = x[2] ?? x[3] ?? ''
  return m
}

function nearestSection(sections, idx) {
  let id = null
  for (const s of sections) {
    if (s.i > idx) break
    id = s.id
  }
  return id
}

function extractNormative(text) {
  const keys = ['MUST NOT', 'SHALL NOT', 'SHOULD NOT', 'MUST', 'SHALL', 'SHOULD', 'RECOMMENDED', 'REQUIRED', 'OPTIONAL', 'MAY']
  const up = text.toUpperCase()
  return keys.filter((k) => up.includes(k))
}

function normalize(v) {
  return v
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((t) => (t.length > 3 && /s$/i.test(t) ? t.slice(0, -1) : t))
    .join(' ')
    .toLowerCase()
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((x) => stable(x)).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
}

function detectCommitOrVersion(indexPath, version) {
  try {
    const root = execSync(`git -C "${path.dirname(indexPath)}" rev-parse --show-toplevel`, { encoding: 'utf8' }).trim()
    return execSync(`git -C "${root}" rev-parse HEAD`, { encoding: 'utf8' }).trim() || version || 'unspecified'
  } catch {
    return version || 'unspecified'
  }
}

function hash(v) {
  return crypto.createHash('sha256').update(v).digest('hex')
}
function canon(v) {
  return v.replace(/\s+/g, ' ').trim()
}
function slug(v) {
  return v.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'term'
}
function clean(v) {
  return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
}
function cut(v, n) {
  return v.length <= n ? v : `${v.slice(0, n - 3)}...`
}
function uniq(a) {
  return Array.from(new Set(a))
}
function group(arr, keyFn) {
  const m = new Map()
  for (const x of arr) {
    const k = keyFn(x)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(x)
  }
  return m
}
function exists(p) {
  return fs.existsSync(p)
}
function must(v, k) {
  if (v === undefined || v === null || v === '') throw new Error(`Missing config value: ${k}`)
  return v
}
function plain(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}
function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8')
}
