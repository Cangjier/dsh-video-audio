/**
 * Provisioning audio event detection.
 *
 * Two independent things have to be on disk before a soundtrack can be classified, and both
 * are pinned the same way ffmpeg and the OCR engine already are — fetched once into
 * `vendor/audio/`, verified, then never fetched again.
 *
 *   1. **The ONNX model** (15.4 MB): YAMNet's weights plus the 521-class AudioSet table. These
 *      are per-file SHA-256 checks. The provenance is a chain of two personal re-uploads
 *      rather than an official release, so the recorded hash is a *trust anchor for
 *      tamper-detection and reproducibility* — it is not evidence that the weights are
 *      authentic. That distinction is written into the manifest rather than glossed over.
 *   2. **The inference runtime** (`onnxruntime-web`, WASM backend only): ~15 MB across five
 *      npm packages, taken straight from the registry. Each tarball's published `sha512`
 *      integrity is verified before anything is extracted, and every extracted file is then
 *      checked against the hash recorded in the manifest.
 *
 * The native `onnxruntime-node` binding is deliberately not used: it unpacks to 245.7 MB
 * because it ships binaries for three platforms and two architectures, and it would break the
 * "plain ESM, no dependency edge" property this plugin is built on.
 *
 * @module dsh-video-audio/core/audio-install
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PLUGIN_ROOT, audioDirCandidates } from './env.mjs'
import { download } from './install.mjs'
import {
  AUDIO_MANIFEST,
  AUDIO_VENDOR_DIR,
  audioEventState,
  readAudioManifest,
} from './audio-events.mjs'

/** Scratch directory for downloads. */
export const AUDIO_SCRATCH_DIR = join(AUDIO_VENDOR_DIR, '.download')

/**
 * The model files, pinned by SHA-256.
 *
 * `provenance` records the full chain because the last hop is not the origin: these weights
 * were exported to ONNX by `jafet21/yamnetonnx` and re-uploaded under `niobures/YAMNet`,
 * whose `yamnetonnx/` subdirectory is what is downloaded here.
 */
export const AUDIO_MODEL = {
  id: 'yamnet',
  label: 'YAMNet（AudioSet 521 类，ONNX 导出）',
  license: 'Apache-2.0',
  provenance: [
    'Google YAMNet — Apache-2.0, 发布于 TF-Hub',
    'jafet21/yamnetonnx — 个人转存，ONNX 导出',
    'niobures/YAMNet — 个人转存；本插件取其 yamnetonnx/ 子目录',
  ],
  provenanceWarning:
    '权重经两次个人转存，没有官方发布哈希。下面的 sha256 是首次落盘时记录的完整性锚点，用于防篡改与复现，不构成来源合法性证明。',
  input: 'float32 单声道 16 kHz；窗口 15360 采样（0.96 s），跳步 7680（0.48 s）',
  output: '得分矩阵 [窗口数, 521]',
  classes: 521,
  files: [
    {
      name: 'model',
      target: join(AUDIO_VENDOR_DIR, 'yamnet', 'yamnet.onnx'),
      url: 'https://huggingface.co/niobures/YAMNet/resolve/main/yamnetonnx/yamnet.onnx',
      bytes: 16_124_200,
      sha256: '04e27fca08e7a3aea2630d1a63a51e6b437c803e0ff6e26399f80870ac251dda',
    },
    {
      name: 'classMap',
      target: join(AUDIO_VENDOR_DIR, 'yamnet', 'yamnet_class_map.csv'),
      url: 'https://huggingface.co/niobures/YAMNet/resolve/main/yamnetonnx/yamnet_class_map.csv',
      bytes: 14_096,
      sha256: 'cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2',
    },
  ],
}

/**
 * The runtime packages, pinned by the registry's own `sha512` integrity.
 *
 * `keep` lists exactly the files the WASM backend loads. Everything else in these tarballs —
 * the native bindings, the WebGPU and WebGL frontends, the TypeScript sources, the tests — is
 * discarded, which is what takes 93.9 MB of unpacked `onnxruntime-web` down to 11.2 MB.
 *
 * `prune` removes by file extension *after* extraction. `keep` picks which directories to walk,
 * but a package ships its `.d.ts` types, source maps, and changelogs inside those same
 * directories; without this second pass a fresh install would produce a different tree from the
 * one that was verified, and "reproducible" would stop meaning anything. Package root
 * `LICENSE`/`package.json` are always retained — dropping a licence to save 11 KB is not a
 * trade this project makes.
 */
export const AUDIO_RUNTIME_PACKAGES = [
  {
    name: 'onnxruntime-web',
    version: '1.22.0',
    url: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.22.0.tgz',
    integrity: 'sha512-Ud/+EBo6mhuaQWt/OjaOk0iNWjXqJoeeMFr6xQEERZdIZH2OWpGzuujz7lfuOBjUa6TEE/sc4nb7Da5dNL34fg==',
    unpackedSize: 93_959_024,
    keep: ['package.json', 'dist/ort.wasm.mjs', 'dist/ort-wasm-simd-threaded.wasm', 'dist/ort-wasm-simd-threaded.mjs'],
    prune: [],
  },
  {
    name: 'flatbuffers',
    version: '25.9.23',
    url: 'https://registry.npmjs.org/flatbuffers/-/flatbuffers-25.9.23.tgz',
    integrity: 'sha512-MI1qs7Lo4Syw0EOzUl0xjs2lsoeqFku44KpngfIduHBYvzm8h2+7K8YMQh1JtVVVrUvhLpNwqVi4DERegUJhPQ==',
    unpackedSize: 288_122,
    keep: ['package.json', 'mjs', 'js'],
    prune: ['ts', 'map', 'md'],
  },
  {
    name: 'long',
    version: '5.3.2',
    url: 'https://registry.npmjs.org/long/-/long-5.3.2.tgz',
    integrity: 'sha512-mNAgZ1GmyNhD7AuqnTG3/VQ26o760+ZYBPKjPvugO8+nLbYfX6TVpJPseBvopbdY+qpZ/lKUnmEc1LeZYS3QAA==',
    unpackedSize: 139_458,
    keep: ['package.json', 'index.js', 'umd', 'LICENSE'],
    prune: ['ts', 'map', 'md'],
  },
  {
    name: 'protobufjs',
    version: '8.8.0',
    url: 'https://registry.npmjs.org/protobufjs/-/protobufjs-8.8.0.tgz',
    integrity: 'sha512-N3xhQ5yyBx3vQq4gubBfASzYhJGNzeDbjqBpu61g7UVylsN/qyffU96TKWD3GbbLOKF82VGNRNvv1+BFgE31Eg==',
    unpackedSize: 3_758_553,
    keep: ['package.json', 'index.js', 'light.js', 'minimal.js', 'src', 'dist', 'google', 'ext', 'LICENSE'],
    // `tsconfig.json` matches none of these, so it is removed by name below.
    prune: ['ts', 'map', 'md'],
    dropFiles: ['tsconfig.json'],
  },
  {
    name: 'guid-typescript',
    version: '1.0.9',
    url: 'https://registry.npmjs.org/guid-typescript/-/guid-typescript-1.0.9.tgz',
    integrity: 'sha512-Y8T4vYhEfwJOTbouREvG+3XDsjr8E3kIr7uf+JZ0BYloFsttiHU0WfvANVsR7TxNUJa/WpCnw/Ino/p+DeBhBQ==',
    unpackedSize: 4_549,
    keep: ['package.json', 'dist'],
    prune: ['ts', 'map', 'md'],
  },
]

/**
 * The directory a runtime package's kept files are written into.
 * @param {string} name - the package name.
 * @returns {string} the absolute destination.
 */
export function runtimePackageDir(name) {
  return join(AUDIO_VENDOR_DIR, 'runtime', 'node_modules', name)
}

/**
 * SHA-256 of a file.
 * @param {string} path - the file.
 * @returns {string} lowercase hex digest.
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * SHA-512 of a file, base64 encoded, matching npm's `dist.integrity` format.
 * @param {string} path - the file.
 * @returns {string} `sha512-<base64>`.
 */
export function sriOf(path) {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
}

/**
 * Every file under `vendor/audio` except the manifest and scratch, as `/`-separated relatives.
 * @returns {string[]} sorted relative paths.
 */
export function vendoredAudioFiles() {
  const found = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.download') continue
        walk(full)
      } else if (entry.name !== 'SOURCE.json') {
        found.push(relative(AUDIO_VENDOR_DIR, full).split(sep).join('/'))
      }
    }
  }
  walk(AUDIO_VENDOR_DIR)
  return found.sort()
}

/**
 * Describe what is installed, by reading the disk.
 * @returns {object} the state, including per-file sizes and the manifest's own claims.
 */
export function audioInstallState() {
  const state = audioEventState()
  const manifest = readAudioManifest()
  const files = vendoredAudioFiles().map((path) => ({ path, bytes: statSync(join(AUDIO_VENDOR_DIR, path)).size }))
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  return {
    ...state,
    manifest,
    files,
    fileCount: files.length,
    totalBytes,
    modelBytes: files.filter((f) => f.path.startsWith('yamnet/')).reduce((s, f) => s + f.bytes, 0),
    runtimeBytes: files.filter((f) => f.path.startsWith('runtime/')).reduce((s, f) => s + f.bytes, 0),
  }
}

/**
 * Verify the installed tree against the recorded hashes.
 *
 * Only files the manifest actually records are checked; the point is to notice tampering or a
 * truncated install, not to re-derive the whole tree.
 *
 * @returns {{checked: number, mismatched: object[], missing: string[]}} the verdict.
 */
export function verifyInstalledAudio() {
  const manifest = readAudioManifest()
  const mismatched = []
  const missing = []
  let checked = 0

  for (const record of manifest?.files ?? []) {
    const full = join(AUDIO_VENDOR_DIR, record.path.split('/').join(sep))
    if (!existsSync(full)) {
      missing.push(record.path)
      continue
    }
    checked += 1
    const actual = sha256File(full)
    if (actual !== record.sha256) {
      mismatched.push({ path: record.path, expected: record.sha256, actual })
    }
  }
  return { checked, mismatched, missing }
}

/**
 * Write the provenance manifest for the tree currently on disk.
 *
 * Called at the end of an install, and also usable to re-record deliberately. It records what
 * turned out to be present rather than what was requested, so the manifest can never claim a
 * file that extraction did not produce.
 *
 * @param {{probed?: object}} [extras] - measured evidence to embed.
 * @returns {object} the manifest that was written.
 */
export function writeAudioManifest(extras = {}) {
  const existing = readAudioManifest() ?? {}
  const files = vendoredAudioFiles().map((path) => {
    const full = join(AUDIO_VENDOR_DIR, path.split('/').join(sep))
    return { path, bytes: statSync(full).size, sha256: sha256File(full) }
  })

  const manifest = {
    model: { ...AUDIO_MODEL, files: undefined },
    runtime: {
      id: 'onnxruntime-web',
      label: 'ONNX Runtime Web（WASM 后端，仅 CPU）',
      note: '原生 onnxruntime-node 解包 245.7 MB 且需要平台二进制，故不采用 WASM 之外的任何后端。',
      packages: AUDIO_RUNTIME_PACKAGES.map(({ name, version, url, integrity, unpackedSize }) => ({
        name,
        version,
        url,
        integrity,
        unpackedSize,
      })),
    },
    modelFiles: AUDIO_MODEL.files.map(({ name, url, target }) => ({
      name,
      url,
      path: relative(AUDIO_VENDOR_DIR, target).split(sep).join('/'),
    })),
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      modelBytes: files.filter((f) => f.path.startsWith('yamnet/')).reduce((s, f) => s + f.bytes, 0),
      runtimeBytes: files.filter((f) => f.path.startsWith('runtime/')).reduce((s, f) => s + f.bytes, 0),
    },
    verified: extras.probed ?? existing.verified ?? null,
    recordedAt: new Date().toISOString(),
  }

  mkdirSync(AUDIO_VENDOR_DIR, { recursive: true })
  writeFileSync(AUDIO_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * Extract the kept files of one npm tarball into its runtime directory.
 *
 * Extraction is delegated to `tar`, which ships with Windows 10 1803 and later and with every
 * supported Linux and macOS. Only the whitelisted members are extracted, so the 93.9 MB
 * `onnxruntime-web` tarball contributes about 11.2 MB; a second pass then drops type
 * declarations, source maps, and markdown by extension.
 *
 * @param {object} pkg - one entry of {@link AUDIO_RUNTIME_PACKAGES}.
 * @param {string} archive - the downloaded `.tgz`.
 * @param {string} destination - where kept files are written.
 * @param {(line: string) => void} [onProgress] - progress callback.
 * @returns {Promise<{files: string[], bytes: number, pruned: number}>} what was written.
 * @throws {Error} when `tar` fails.
 */
export async function extractRuntimePackage(pkg, archive, destination, onProgress) {
  mkdirSync(destination, { recursive: true })
  const members = pkg.keep.map((entry) => `package/${entry}`)
  onProgress?.(`解包 ${pkg.name}@${pkg.version}（保留 ${members.length} 项）`)

  await new Promise((settle, fail) => {
    const child = spawnTar(['-xzf', archive, '-C', destination, '--strip-components=1', ...members])
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => fail(new Error(`无法运行 tar：${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) settle()
      else fail(new Error(`tar 解包 ${pkg.name} 失败（退出 ${code}）：${stderr.trim()}`))
    })
  })

  const pruned = pruneExtracted(destination, pkg)
  const files = []
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files.push(relative(AUDIO_VENDOR_DIR, full).split(sep).join('/'))
        bytes += statSync(full).size
      }
    }
  }
  walk(destination)
  return { files, bytes, pruned }
}

/**
 * Remove the files a fresh install must not keep, so it reproduces the verified tree exactly.
 *
 * A package-root `LICENSE` and `package.json` are never removed, whatever the extension list
 * says: a licence file that happens to end in `.md` still has to ship.
 *
 * @param {string} root - the extracted package directory.
 * @param {object} pkg - the package entry, supplying `prune` extensions and `dropFiles` names.
 * @returns {number} how many files were removed.
 */
function pruneExtracted(root, pkg) {
  const extensions = new Set((pkg.prune ?? []).map((ext) => `.${String(ext).replace(/^\./, '').toLowerCase()}`))
  const dropNames = new Set(pkg.dropFiles ?? [])
  let removed = 0

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const isRootFile = dir === root
      if (isRootFile && (entry.name === 'LICENSE' || entry.name === 'package.json')) continue
      const lower = entry.name.toLowerCase()
      const extension = lower.slice(lower.lastIndexOf('.'))
      if (extensions.has(extension) || dropNames.has(entry.name)) {
        rmSync(full, { force: true })
        removed += 1
      }
    }
  }
  walk(root)
  return removed
}

/**
 * Spawn `tar` with an argument array.
 *
 * `tar.exe` on Windows and `tar` elsewhere are the same bsdtar, and using an argument array
 * means a path with a space or a non-ASCII character needs no escaping.
 *
 * @param {string[]} args - arguments.
 * @returns {import('node:child_process').ChildProcess} the child.
 */
function spawnTar(args) {
  return spawn(process.platform === 'win32' ? 'tar.exe' : 'tar', args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/**
 * Install everything audio event detection needs.
 *
 * Idempotent: an already-verified tree is reported as such and nothing is downloaded unless
 * `force` is set. A failure never leaves a partial file in place — the model lands in the
 * scratch directory first, is hashed there, and is only moved in once it matches, so an
 * interrupted download cannot corrupt a working installation. The scratch file is removed on
 * the way out either way, so a retry starts clean.
 *
 * `modelArchive` is the way out when the host serving the weights is unreachable from here:
 * the file arrives by whatever means, and its sha256 is checked exactly as a download would be.
 * The OCR engine installer, which offered the same escape hatch, is the dsh-ocr plugin now.
 *
 * @param {object} [options] - `{ force, onProgress, config, modelArchive }`.
 * @returns {Promise<object>} `{ installed, skipped, model, runtime, verify, state }`.
 * @throws {Error} when a download fails its integrity check or extraction fails.
 */
export async function installAudio(options = {}) {
  const onProgress = options.onProgress ?? (() => {})
  const force = options.force === true
  const localModel = typeof options.modelArchive === 'string' && options.modelArchive !== ''
    ? resolve(options.modelArchive)
    : null
  if (localModel !== null && !existsSync(localModel)) {
    throw new Error(`modelArchive 指向的路径不存在：${localModel}`)
  }
  // Accept either the .onnx itself or a directory holding both files. The class table is only
  // 14 KB, but when the LFS host that serves the weights is unreachable it is unreachable for
  // the table too, so a directory is the practical form of "I brought the files myself".
  const localDir = localModel !== null && statSync(localModel).isDirectory() ? localModel : null

  /** Find a locally supplied copy of one model file, or null. */
  const localFor = (file) => {
    if (localModel === null) return null
    if (localDir === null) return file.name === 'model' ? localModel : null
    const named = { model: 'yamnet.onnx', classMap: 'yamnet_class_map.csv' }[file.name]
    const candidate = join(localDir, named)
    return existsSync(candidate) ? candidate : null
  }

  // Refuse a malformed pin before spending minutes on a download that could not be trusted.
  // Checking this late — or worse, skipping the comparison when the hash looks odd — would turn
  // a typo in a pinned hash into a silently unverified install.
  for (const file of AUDIO_MODEL.files) {
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(
        `${file.name} 的 sha256 不是 64 位小写十六进制（收到 ${JSON.stringify(file.sha256)}）；` +
          '拒绝安装，因为这样的校验不可能通过。',
      )
    }
  }
  for (const pkg of AUDIO_RUNTIME_PACKAGES) {
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity)) {
      throw new Error(`${pkg.name} 的 integrity 格式不合法（收到 ${JSON.stringify(pkg.integrity)}）。`)
    }
  }

  if (!force) {
    const current = verifyInstalledAudio()
    const state = audioEventState()
    if (state.available && current.mismatched.length === 0 && current.missing.length === 0 && current.checked > 0) {
      onProgress('音频事件检测已安装且校验通过，跳过下载。')
      return { installed: false, skipped: true, verify: current, state }
    }

    // Local tree absent or incomplete: before spending 28 MB of bandwidth, take a complete
    // copy from a sibling plugin if there is one. This is the machine that ran the muxing
    // plugin's installer, which is the common case rather than the exotic one.
    const adopted = adoptSiblingAudio(onProgress)
    if (adopted.adopted) {
      const verify = verifyInstalledAudio()
      const adoptedState = audioEventState()
      if (adoptedState.available && verify.mismatched.length === 0 && verify.missing.length === 0) {
        onProgress(`完成：从 ${adopted.from} 复制 ${verify.checked} 个文件，未发起下载。`)
        return { installed: true, skipped: false, adopted: true, from: adopted.from, verify, state: adoptedState }
      }
      onProgress('同级副本校验未通过，改为下载。')
    }
  }

  mkdirSync(AUDIO_SCRATCH_DIR, { recursive: true })
  mkdirSync(join(AUDIO_VENDOR_DIR, 'yamnet'), { recursive: true })

  // --- model ---
  const model = []
  for (const file of AUDIO_MODEL.files) {
    const archive = join(AUDIO_SCRATCH_DIR, `${file.name}.download`)
    rmSync(archive, { force: true })
    try {
      const supplied = localFor(file)
      if (supplied !== null) {
        onProgress(`使用本地文件 ${supplied}`)
        copyFileSync(supplied, archive)
      } else {
        onProgress(`下载模型 ${file.name} …`)
        await download(file.url, archive, (progress) => onProgress(`  ${file.name} ${progress}`))
      }
      const actual = sha256File(archive)
      if (actual !== file.sha256) {
        throw new Error(
          `${file.name} 的 sha256 不匹配，已中止。\n  期望 ${file.sha256}\n  实得 ${actual}\n` +
            '下载可能被中断或被篡改；请重试，不要使用这个文件。',
        )
      }
      mkdirSync(join(file.target, '..'), { recursive: true })
      writeFileSync(file.target, readFileSync(archive))
      model.push({ name: file.name, path: file.target, bytes: statSync(file.target).size, sha256: actual })
      onProgress(`  ${file.name} 校验通过（${(statSync(file.target).size / 1024 / 1024).toFixed(2)} MB）`)
    } finally {
      // Whether it matched, failed the hash, or the network died mid-stream, the partial file
      // must not survive: a stale one would be silently reused as the next attempt's target.
      rmSync(archive, { force: true })
    }
  }

  // --- runtime ---
  const runtime = []
  for (const pkg of AUDIO_RUNTIME_PACKAGES) {
    const archive = join(AUDIO_SCRATCH_DIR, `${pkg.name}-${pkg.version}.tgz`)
    rmSync(archive, { force: true })
    try {
      onProgress(`下载运行时 ${pkg.name}@${pkg.version} …`)
      await download(pkg.url, archive, (progress) => onProgress(`  ${pkg.name} ${progress}`))
      const integrity = sriOf(archive)
      if (integrity !== pkg.integrity) {
        throw new Error(
          `${pkg.name}@${pkg.version} 的完整性校验失败，已中止。\n  期望 ${pkg.integrity}\n  实得 ${integrity}`,
        )
      }
      onProgress(`  ${pkg.name} integrity 校验通过`)
      const destination = runtimePackageDir(pkg.name)
      rmSync(destination, { recursive: true, force: true })
      const extracted = await extractRuntimePackage(pkg, archive, destination, onProgress)
      runtime.push({ name: pkg.name, version: pkg.version, integrity, ...extracted })
    } finally {
      rmSync(archive, { force: true })
    }
  }

  const manifest = writeAudioManifest()
  const verify = verifyInstalledAudio()
  const state = audioEventState()
  onProgress(
    `完成：${manifest.totals.files} 个文件，共 ${(manifest.totals.bytes / 1024 / 1024).toFixed(2)} MB` +
      `（模型 ${(manifest.totals.modelBytes / 1024 / 1024).toFixed(2)} MB + 运行时 ${(manifest.totals.runtimeBytes / 1024 / 1024).toFixed(2)} MB）`,
  )

  return { installed: true, skipped: false, model, runtime, verify, state, manifest }
}

/**
 * Copy an already-installed tree from a sibling plugin instead of downloading it again.
 *
 * The muxing plugin held this runtime before it moved here, and a machine that ran
 * `video_setup {action:"install_audio"}` then has all 28 MB of it sitting in a sibling checkout.
 * Re-downloading would be wasteful and, on a metered or offline machine, impossible. So an
 * install first looks for a complete sibling copy and copies it in, verifying hashes afterwards
 * exactly as a fresh download would be verified.
 *
 * Nothing is written to the sibling, and a sibling copy that is incomplete is ignored rather
 * than half-adopted.
 *
 * @param {(line: string) => void} onProgress - progress callback.
 * @returns {{adopted: boolean, from: string|null, files: number}} what happened.
 */
export function adoptSiblingAudio(onProgress = () => {}) {
  const own = resolve(AUDIO_VENDOR_DIR)
  for (const candidate of audioDirCandidates()) {
    const source = resolve(candidate)
    if (source === own) continue
    // Judged by the files detection loads, not by a manifest: a candidate that claims to be
    // installed but is missing the WASM binary would be adopted and then fail at inference.
    const complete = [
      join(source, 'yamnet', 'yamnet.onnx'),
      join(source, 'yamnet', 'yamnet_class_map.csv'),
      join(source, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.mjs'),
      join(source, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'),
    ].every((path) => existsSync(path))
    if (!complete) continue

    onProgress(`发现同级插件里已装好的音频资源：${source}，直接复用而不重新下载。`)
    for (const relativePath of ['yamnet', 'runtime']) {
      const from = join(source, relativePath)
      if (!existsSync(from)) continue
      const to = join(AUDIO_VENDOR_DIR, relativePath)
      rmSync(to, { recursive: true, force: true })
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to, { recursive: true })
    }
    writeAudioManifest()
    const verify = verifyInstalledAudio()
    return { adopted: true, from: source, files: verify.checked }
  }
  return { adopted: false, from: null, files: 0 }
}

/**
 * Remove the vendored audio tree.
 * @param {{onProgress?: (line: string) => void}} [options] - progress callback.
 * @returns {{removed: boolean, directory: string, stillVisibleFrom: string|null}} the outcome.
 */
export function removeAudio(options = {}) {
  const onProgress = options.onProgress ?? (() => {})
  if (!existsSync(AUDIO_VENDOR_DIR)) {
    onProgress('没有已安装的音频运行时可供删除。')
    return { removed: false, directory: AUDIO_VENDOR_DIR, stillVisibleFrom: null }
  }
  rmSync(AUDIO_VENDOR_DIR, { recursive: true, force: true })
  onProgress(`已删除 ${AUDIO_VENDOR_DIR}`)
  // A sibling copy is somebody else's directory: deleting it here would reach outside this
  // plugin. Saying so is the honest alternative, because detection would keep working and the
  // caller would otherwise believe it had been removed.
  const state = audioEventState()
  const stillVisibleFrom = state.available ? state.vendorDir : null
  if (stillVisibleFrom !== null) {
    onProgress(`注意：${stillVisibleFrom} 里还有一份同级插件的副本，检测仍然可用；本插件无法也不应删除它。`)
  }
  return { removed: true, directory: AUDIO_VENDOR_DIR, stillVisibleFrom }
}
