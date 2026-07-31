// SPDX-FileCopyrightText: (C) 2026 Intel Corporation
// SPDX-License-Identifier: Apache-2.0
//
// Round-trip fidelity gate for the Interactive tab's YAML serializer.
//
// Run:  cd web && npx tsx src/lib/draftFromYaml.fidelity.test.mjs
//
// There is no test runner configured in this package, so this is a standalone
// script that exits non-zero on failure — usable directly in CI.
//
// WHY THIS EXISTS
//
// A UI dispatch handed the Jenkins farm a template with systemConfig.bootloader
// silently stripped. The ubuntu24 default (systemd-boot) then won the defaults
// merge over the template's own `provider: grub`, and the build died looking for
// an .efi the template had deliberately purged. Two sibling builds went GREEN
// while shipping images that did not match their templates — a worse outcome
// than the failure, because nothing surfaced.
//
// The invariant below is the one that would have caught it, and it is absolute:
// loading a template and dispatching WITHOUT touching a control must reproduce
// that template byte for byte. Anything less means the farm builds something
// other than what the operator selected.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import YAML from 'yaml'
import { parseYamlToDraft, applyOverrides } from './draftFromYaml.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, '..', '..', '..', 'image-templates')

let failures = 0
const fail = (msg) => {
  console.error('FAIL: ' + msg)
  failures++
}

const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.yml'))
if (files.length === 0) fail('no templates found at ' + TEMPLATES)

// ---------------------------------------------------------------------------
// 1. Untouched round-trip is byte-identical.
// ---------------------------------------------------------------------------
let identical = 0
for (const f of files) {
  const src = readFileSync(join(TEMPLATES, f), 'utf8')
  let out
  try {
    out = applyOverrides(parseYamlToDraft(src))
  } catch (e) {
    fail(`${f}: threw during round-trip: ${e.message}`)
    continue
  }
  if (out === src) identical++
  else fail(`${f}: untouched round-trip is not byte-identical (${src.length} -> ${out.length} bytes)`)
}
console.log(`untouched round-trip byte-identical: ${identical}/${files.length}`)

// ---------------------------------------------------------------------------
// 2. An EDITED draft still preserves every field the form does not own.
//    This is the guard against "fixed by always passing through", which would
//    make case 1 pass while silently breaking real edits.
// ---------------------------------------------------------------------------
const deepGet = (o, path) => path.split('.').reduce((a, k) => (a ?? {})[k], o)
const MUST_SURVIVE_EDIT = [
  'systemConfig.bootloader',
  'systemConfig.additionalFiles',
  'systemConfig.immutability',
  'systemConfig.configurations',
  'disk.artifacts',
  'packageRepositories',
]

let editChecked = 0
for (const f of files) {
  const src = readFileSync(join(TEMPLATES, f), 'utf8')
  const srcDoc = YAML.parse(src)
  let draft
  try {
    draft = parseYamlToDraft(src)
  } catch {
    continue
  }
  // A minimal user edit: rename the image. Must force reconstruction.
  const edited = { ...draft, imageName: 'fidelity-probe' }
  let out
  try {
    out = applyOverrides(edited)
  } catch (e) {
    fail(`${f}: threw when serializing an edited draft: ${e.message}`)
    continue
  }
  if (out === src) {
    fail(`${f}: an edited draft returned the pristine seed — the edit was lost`)
    continue
  }
  const outDoc = YAML.parse(out)
  if (deepGet(outDoc, 'image.name') !== 'fidelity-probe') {
    fail(`${f}: edited image.name did not reach the output`)
  }
  for (const path of MUST_SURVIVE_EDIT) {
    const before = deepGet(srcDoc, path)
    if (before === undefined) continue
    if (deepGet(outDoc, path) === undefined) {
      fail(`${f}: ${path} was dropped when the draft was edited`)
    }
  }
  editChecked++
}
console.log(`edited-draft field preservation checked: ${editChecked}/${files.length}`)

// ---------------------------------------------------------------------------
// 3. Unit parsing must agree with the Go engine
//    (internal/image/imagedisc/imagedisc.go:96-97): binary units and the bare
//    shorthand are powers of two; the SI forms are powers of ten.
// ---------------------------------------------------------------------------
const { parseSizeToMiB } = await import('./draftFromYaml.ts')
const MIB = 1048576
const unitCases = [
  ['1MiB', 1],
  ['1M', 1],
  ['1MB', 1000000 / MIB],
  ['1GiB', 1024],
  ['1G', 1024],
  ['1GB', 1000000000 / MIB],
  ['513MB', (513 * 1000000) / MIB],
]
for (const [input, want] of unitCases) {
  const got = parseSizeToMiB(input)
  if (Math.abs(got - want) > 1e-9) {
    fail(`parseSizeToMiB(${input}) = ${got}, want ${want}`)
  }
}
console.log(`unit parity cases checked: ${unitCases.length}`)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall fidelity checks passed')
