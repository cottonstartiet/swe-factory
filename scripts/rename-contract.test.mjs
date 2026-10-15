import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function read(path) {
  return readFile(path, 'utf8')
}

test('SWE Factory uses the canonical application identifiers', async () => {
  const [packageJson, cargoToml, tauriConfig, deepLinks, database, theme, extension] =
    await Promise.all([
      read('package.json'),
      read('src-tauri/Cargo.toml'),
      read('src-tauri/tauri.conf.json'),
      read('src/renderer/src/lib/deep-links.ts'),
      read('src-tauri/src/db.rs'),
      read('src/renderer/src/contexts/theme-context.tsx'),
      read('browser-extension/popup.js')
    ])

  const packageManifest = JSON.parse(packageJson)
  assert.equal(packageManifest.name, 'swe-factory')
  assert.match(cargoToml, /^name = "swe-factory"$/m)
  assert.match(cargoToml, /^name = "swe_factory_lib"$/m)

  const tauri = JSON.parse(tauriConfig)
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1]
  assert.equal(tauri.version, packageManifest.version)
  assert.equal(cargoVersion, packageManifest.version)
  assert.equal(tauri.productName, 'SWE Factory')
  assert.equal(tauri.identifier, 'com.ritekode.swefactory')
  assert.deepEqual(tauri.plugins['deep-link'].desktop.schemes, ['swefactory'])

  assert.match(deepLinks, /deepLink\.protocol !== 'swefactory:'/)
  assert.doesNotMatch(deepLinks, new RegExp(['dev', 'trees:'].join(''), 'i'))
  assert.match(database, /const DB_FILE: &str = "swe-factory\.db";/)
  assert.match(theme, /'swe-factory-theme'/)
  assert.match(theme, /'swe-factory-color-theme'/)
  assert.match(extension, /new URL\('swefactory:\/\/tasks\/new'\)/)
})

test('legacy branding remains only in the unchanged repository URL', () => {
  const legacyCompact = ['dev', 'trees'].join('')
  const legacySpaced = ['dev', '[ -]', 'trees'].join('')
  const legacyDashed = ['dev', '-', 'trees'].join('')
  const output = execFileSync(
    'git',
    [
      'grep',
      '-n',
      '-i',
      '-E',
      `${legacyCompact}|${legacySpaced}|${legacyDashed}|${legacyCompact.toUpperCase()}`,
      '--',
      'src',
      'src-tauri',
      'browser-extension'
    ],
    { encoding: 'utf8' }
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)

  assert.equal(output.length, 1)
  assert.match(
    output[0],
    new RegExp(
      `^src-tauri/tauri\\.conf\\.json:\\d+:\\s+"https://github\\.com/cottonstartiet/${[
        'Dev',
        'Trees'
      ].join('')}/releases/latest/download/latest\\.json"$`
    )
  )
})
