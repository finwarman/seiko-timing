/** Biquad en forma directa II transpuesta, con estado persistente entre bloques. */
export class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
    this.z1 = 0; this.z2 = 0;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
  processInPlace(x) {
    let z1 = this.z1, z2 = this.z2;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const y = b0 * xi + z1;
      z1 = b1 * xi - a1 * y + z2;
      z2 = b2 * xi - a2 * y;
      x[i] = y;
    }
    // Evita que denormales congelen el bucle cuando la señal es silencio.
    this.z1 = Math.abs(z1) < 1e-30 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-30 ? 0 : z2;
  }
}

function highpass(fs, f0, q) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  const a0 = 1 + a;
  return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0,
                    (-2 * c) / a0, (1 - a) / a0);
}

function lowpass(fs, f0, q) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * q);
  const a0 = 1 + a;
  return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0,
                    (-2 * c) / a0, (1 - a) / a0);
}

// Q de un Butterworth de 4º orden: dos secciones de 2º orden.
const BUTTER4_Q = [0.54119610, 1.30656296];

/**
 * Paso banda de 4º orden por cascada HP+LP.
 *
 * Se usa cascada en vez de un biquad bandpass único porque la banda útil del
 * tic es ancha (típicamente 1-8 kHz) y un bandpass de Q bajo apenas atenúa.
 */
export class Bandpass {
  constructor(fs, lo, hi) {
    this.fs = fs;
    this.setBand(lo, hi);
  }
  setBand(lo, hi) {
    this.lo = lo; this.hi = hi;
    const nyq = this.fs / 2;
    const h = Math.min(hi, nyq * 0.95);
    this.stages = [];
    for (const q of BUTTER4_Q) this.stages.push(highpass(this.fs, lo, q));
    for (const q of BUTTER4_Q) this.stages.push(lowpass(this.fs, h, q));
  }
  reset() { for (const s of this.stages) s.reset(); }
  processInPlace(x) { for (const s of this.stages) s.processInPlace(x); }
}

/**
 * Envolvente por operador de energía de Teager-Kaiser.
 *
 *   psi[n] = x[n]^2 - x[n-1]*x[n+1]
 *
 * Frente a rectificar y suavizar, TKEO marca mucho mejor los transitorios
 * bruscos: es lo que permite separar los tres ruidos del escape, que es de
 * donde sale la amplitud. La salida se rectifica y se suaviza con un polo.
 *
 * Escribe en `out` la envolvente correspondiente a las muestras de `x`,
 * retrasada un sample (se resuelve con el estado, no hay desfase entre bloques).
 */
export class Envelope {
  constructor(fs, tauSeconds = 0.00035) {
    this.fs = fs;
    this.setTau(tauSeconds);
    this.xm1 = 0; this.xm2 = 0;
    this.y = 0;
  }
  setTau(tau) { this.alpha = 1 - Math.exp(-1 / (tau * this.fs)); }
  reset() { this.xm1 = 0; this.xm2 = 0; this.y = 0; }
  process(x, out) {
    let xm1 = this.xm1, xm2 = this.xm2, y = this.y;
    const a = this.alpha;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      // psi centrado en xm1, usando xm2 y xi como vecinos.
      let psi = xm1 * xm1 - xm2 * xi;
      if (psi < 0) psi = 0;
      y += (psi - y) * a;
      out[i] = y;
      xm2 = xm1; xm1 = xi;
    }
    this.xm1 = xm1; this.xm2 = xm2; this.y = y;
    return out;
  }
}
