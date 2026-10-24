const MAX_RATE = 48000;
const HALF_TAPS = 16;

export function resampleAudio(input, sampleRate) {
  let factor = 1;
  while (sampleRate / factor > MAX_RATE) factor *= 2;
  if (factor === 1) return { samples: input, sampleRate };
  const radius = HALF_TAPS * factor;
  const taps = new Float64Array(2 * radius + 1);
  const cutoff = 0.43 / factor;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const sinc = i === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i);
    const window = 0.42 + 0.5 * Math.cos(Math.PI * i / radius) + 0.08 * Math.cos(2 * Math.PI * i / radius);
    taps[i + radius] = sinc * window;
    sum += taps[i + radius];
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  const output = new Float32Array(Math.floor(input.length / factor));
  for (let i = 0; i < output.length; i++) {
    const centre = i * factor;
    let value = 0;
    for (let tap = Math.max(0, radius - centre); tap < taps.length && centre + tap - radius < input.length; tap++) {
      value += input[centre + tap - radius] * taps[tap];
    }
    output[i] = value;
  }
  return { samples: output, sampleRate: sampleRate / factor };
}
