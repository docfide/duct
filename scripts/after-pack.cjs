// electron-builder afterPack: keep only this platform's ONNX Runtime binaries (the speech engine for audio search).
// onnxruntime-node ships every platform's (about 300 MB); file patterns can't pick by platform, so the others are
// deleted from the packed app here.
const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('builder-util')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName            // darwin, linux, win32
  const arch = Arch[context.arch]                           // x64, arm64…
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const bin = join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin')
  if (!existsSync(bin)) throw new Error(`ONNX Runtime binaries are missing from the packed app (${bin})`)
  let kept = 0
  for (const napi of readdirSync(bin)) {
    for (const os of readdirSync(join(bin, napi))) {
      for (const cpu of readdirSync(join(bin, napi, os))) {
        if (os === platform && cpu === arch) {
          kept++
          // GPU add-ons (CUDA, TensorRT): transcription runs on the CPU.
          for (const f of readdirSync(join(bin, napi, os, cpu))) if (/providers_(cuda|tensorrt|rocm)/i.test(f)) rmSync(join(bin, napi, os, cpu, f), { force: true })
        } else rmSync(join(bin, napi, os, cpu), { recursive: true, force: true })
      }
      if (!readdirSync(join(bin, napi, os)).length) rmSync(join(bin, napi, os), { recursive: true, force: true })
    }
  }
  // Intel Macs have no ONNX Runtime build; audio search says so there (src/speech.ts).
  if (!kept && !(platform === 'darwin' && arch === 'x64')) throw new Error(`No ONNX Runtime binaries for ${platform}-${arch}`)
}
