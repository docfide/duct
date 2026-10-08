// Generates the Electron app and tray icons from the mascot SVGs in assets/mascot.
// Run with `npm run icons` after changing app-icon.svg, tray-template.svg or view-three-quarter.svg.
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const mascot = join(root, 'assets', 'mascot')
const electron = join(root, 'electron')
const icons = join(electron, 'icons')
mkdirSync(icons, { recursive: true })

const transparent = { r: 0, g: 0, b: 0, alpha: 0 }

function render(svg, size) {
  return sharp(join(mascot, svg), { density: 600 })
    .trim()
    .resize(size, size, { fit: 'contain', background: transparent })
    .png()
}

// macOS menu bar: black shape with transparent holes. The "Template" suffix makes
// Electron mark it as a template image so macOS recolours it for light/dark menu bars.
await render('tray-template.svg', 16).toFile(join(icons, 'trayTemplate.png'))
await render('tray-template.svg', 32).toFile(join(icons, 'trayTemplate@2x.png'))

// Windows/Linux tray: the coloured head.
await render('view-three-quarter.svg', 16).toFile(join(icons, 'tray.png'))
await render('view-three-quarter.svg', 32).toFile(join(icons, 'tray@2x.png'))

// Windows/Linux app icon (electron-builder derives .ico and Linux sizes from this).
await sharp(join(mascot, 'app-icon.svg'), { density: 600 }).resize(1024, 1024).png().toFile(join(electron, 'icon.png'))

// macOS app icon: Apple's grid puts the 824px rounded square inside a 1024px canvas.
if (process.platform === 'darwin') {
  const body = await sharp(join(mascot, 'app-icon.svg'), { density: 600 }).resize(824, 824).png().toBuffer()
  const master = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: transparent } })
    .composite([{ input: body, left: 100, top: 100 }])
    .png()
    .toBuffer()
  const work = mkdtempSync(join(tmpdir(), 'duct-icons-'))
  const iconset = join(work, 'icon.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(master).resize(size, size).png().toFile(join(iconset, `icon_${size}x${size}.png`))
    await sharp(master).resize(size * 2, size * 2).png().toFile(join(iconset, `icon_${size}x${size}@2x.png`))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(electron, 'icon.icns')])
  rmSync(work, { recursive: true, force: true })
} else {
  console.warn('Skipping icon.icns: iconutil is only available on macOS.')
}

console.log('Icons written to electron/ and electron/icons/')
