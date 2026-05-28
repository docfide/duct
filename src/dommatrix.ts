export async function ensureDOMMatrix(): Promise<void> {
  if (typeof globalThis.DOMMatrix !== 'undefined') return

  // canvas npm package ships its own DOMMatrix — steal it
  try {
    const mod: any = await import('canvas')
    if (mod.DOMMatrix) {
      ;(globalThis as any).DOMMatrix = mod.DOMMatrix
      return
    }
  } catch {}

  // Minimal polyfill for pdfjs-dist (2D affine subset only)
  class DOMMatrixPolyfill {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0

    constructor(init?: string | number[]) {
      if (Array.isArray(init) && init.length >= 6) {
        this.a = init[0]; this.b = init[1]; this.c = init[2]
        this.d = init[3]; this.e = init[4]; this.f = init[5]
      }
    }

    translate(tx: number, ty: number): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([this.a, this.b, this.c, this.d,
        this.a * tx + this.c * ty + this.e,
        this.b * tx + this.d * ty + this.f])
    }

    scale(sx: number, sy: number): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([this.a * sx, this.b * sx, this.c * sy, this.d * sy, this.e, this.f])
    }

    multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ])
    }

    inverse(): DOMMatrixPolyfill {
      const det = this.a * this.d - this.b * this.c
      if (Math.abs(det) < 1e-12) throw new Error('Matrix not invertible')
      const inv = 1 / det
      return new DOMMatrixPolyfill([
        this.d * inv, -this.b * inv, -this.c * inv, this.a * inv,
        (this.c * this.f - this.d * this.e) * inv,
        (this.b * this.e - this.a * this.f) * inv,
      ])
    }

    rotate(angle: number): DOMMatrixPolyfill {
      const rad = angle * Math.PI / 180
      const cos = Math.cos(rad); const sin = Math.sin(rad)
      return new DOMMatrixPolyfill([
        this.a * cos + this.c * sin,
        this.b * cos + this.d * sin,
        this.a * -sin + this.c * cos,
        this.b * -sin + this.d * cos,
        this.e, this.f,
      ])
    }
  }

  ;(globalThis as any).DOMMatrix = DOMMatrixPolyfill
}
