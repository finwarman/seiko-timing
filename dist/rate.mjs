// Average cadence can be measurable even when individual escapement peaks move.
export const RateQuality = Object.freeze({
  Waiting: 'waiting', Searching: 'searching', Unsteady: 'unsteady',
  Usable: 'usable', Stable: 'stable',
});

const CORRELATION_RATE = 2000;
const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;
const MIN_SECONDS = 18;
const MIN_CORRELATION = 0.08;
const MIN_RIDGE_CORRELATION = 0.025;
const STABLE_SPREAD = 20;
const USABLE_SPREAD = 100;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function fft(real, imaginary, direction) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let span = 2; span <= size; span *= 2) {
    const angle = direction * 2 * Math.PI / span;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    for (let start = 0; start < size; start += span) {
      let c = 1, s = 0;
      for (let i = 0; i < span / 2; i++) {
        const left = start + i, right = left + span / 2;
        const re = real[right] * c - imaginary[right] * s;
        const im = real[right] * s + imaginary[right] * c;
        real[right] = real[left] - re; imaginary[right] = imaginary[left] - im;
        real[left] += re; imaginary[left] += im;
        const next = c * cosine - s * sine;
        s = s * cosine + c * sine; c = next;
      }
    }
  }
}

function prepareEnvelope(input, frameRate) {
  const block = Math.max(1, Math.round(frameRate / CORRELATION_RATE));
  const values = new Float64Array(Math.floor(input.length / block));
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < block; j++) values[i] += input[i * block + j] / block;
  }
  const distribution = [];
  const stride = Math.max(1, Math.floor(values.length / 10000));
  for (let i = 0; i < values.length; i += stride) distribution.push(values[i]);
  distribution.sort((a, b) => a - b);
  const floor = Math.max(1e-10, distribution[Math.floor(distribution.length / 2)] || 0);
  const ceiling = distribution[Math.floor(distribution.length * 0.995)] || floor;
  const sums = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.log1p(Math.min(values[i], ceiling) / floor);
    sums[i + 1] = sums[i] + values[i];
  }
  const sampleRate = frameRate / block;
  const radius = Math.round(sampleRate * 0.05);
  // Remove slow gain changes. Log compression limits loud knocks' influence.
  for (let i = 0; i < values.length; i++) {
    const first = Math.max(0, i - radius), last = Math.min(values.length, i + radius + 1);
    values[i] -= (sums[last] - sums[first]) / (last - first);
  }
  return { values, sampleRate, contrast: ceiling / floor };
}

function autocorrelation(values) {
  const size = 2 ** Math.ceil(Math.log2(2 * values.length));
  const real = new Float64Array(size), imaginary = new Float64Array(size);
  real.set(values);
  fft(real, imaginary, -1);
  for (let i = 0; i < size; i++) {
    real[i] = real[i] ** 2 + imaginary[i] ** 2;
    imaginary[i] = 0;
  }
  fft(real, imaginary, 1);
  const sums = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) sums[i + 1] = sums[i] + values[i] ** 2;
  const result = new Float64Array(Math.floor(values.length / 3) + 2);
  for (let lag = 0; lag < result.length; lag++) {
    const denominator = Math.sqrt(sums[values.length - lag] * (sums[values.length] - sums[lag]));
    result[lag] = denominator > 1e-18 ? real[lag] / size / denominator : 0;
  }
  return result;
}

function findPeak(curve, first, last) {
  first = Math.max(1, Math.ceil(first));
  last = Math.min(curve.length - 2, Math.floor(last));
  let best = first;
  for (let i = first + 1; i <= last; i++) if (curve[i] > curve[best]) best = i;
  if (best <= first || best >= last) return null;
  const curvature = curve[best - 1] - 2 * curve[best] + curve[best + 1];
  const offset = curvature < 0 ? (curve[best - 1] - curve[best + 1]) / (2 * curvature) : 0;
  return { lag: best + Math.max(-0.5, Math.min(0.5, offset)), correlation: curve[best] };
}

function fitRidge(curve, seed, sampleRate) {
  let period = seed;
  const peaks = [];
  for (let cycles = 1; cycles * period < curve.length - sampleRate * 0.02; cycles *= 2) {
    const radius = Math.min(period * 0.18, sampleRate * (0.003 + cycles * 0.0008));
    const peak = findPeak(curve, cycles * period - radius, cycles * period + radius);
    if (!peak || peak.correlation < (cycles === 1 ? MIN_CORRELATION : MIN_RIDGE_CORRELATION)) break;
    peaks.push({ ...peak, cycles });
    let numerator = 0, denominator = 0;
    for (const value of peaks) {
      numerator += value.cycles * value.lag * value.correlation;
      denominator += value.cycles ** 2 * value.correlation;
    }
    period = numerator / denominator;
  }
  if (peaks.length < 4) return null;
  const longest = peaks.at(-1).cycles;
  const longPeaks = peaks.filter(peak => peak.cycles >= longest / 4);
  const rates = longPeaks.map(peak => sampleRate * peak.cycles / peak.lag);
  const spread = Math.max(...rates.map(rate => Math.abs(rate / (sampleRate / period) - 1))) * DAY_SECONDS;
  return { period: period / sampleRate, spread,
    correlation: median(peaks.map(peak => peak.correlation)),
    score: peaks.length + median(peaks.map(peak => peak.correlation)) };
}

function segmentRate(values, sampleRate, expected) {
  const curve = autocorrelation(values);
  const first = Math.ceil(expected * 0.88 * sampleRate), last = Math.floor(expected * 1.12 * sampleRate);
  const seeds = [];
  for (let i = first; i <= last; i++) {
    if (curve[i] >= MIN_CORRELATION && curve[i] > curve[i - 1] && curve[i] >= curve[i + 1]) seeds.push(i);
  }
  seeds.sort((a, b) => curve[b] - curve[a]);
  let best = null;
  for (const seed of seeds.slice(0, 5)) {
    const candidate = fitRidge(curve, seed, sampleRate);
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }
  return best;
}

/** Spread measures agreement across lags and independent halves, not clock accuracy. */
export function estimateRate(envelope, frameRate, bph) {
  const result = { quality: RateQuality.Waiting, rate: null, bph: null, period: null,
    spread: null, correlation: 0, segmentRates: [],
    reason: 'Collect eighteen seconds for waveform averaging.' };
  if (envelope.length / frameRate < MIN_SECONDS) return result;
  const { values, sampleRate, contrast } = prepareEnvelope(envelope, frameRate);
  if (contrast < 1.8) {
    result.quality = RateQuality.Searching;
    result.reason = 'The signal lacks distinct clicks for waveform timing.';
    return result;
  }
  const expected = 2 * HOUR_SECONDS / bph;
  const middle = Math.floor(values.length / 2);
  const segments = [values, values.subarray(0, middle), values.subarray(middle)]
    .map(segment => segmentRate(segment, sampleRate, expected));
  result.quality = RateQuality.Searching;
  result.reason = 'Waveform averaging has not found a repeatable full-cycle rhythm in both halves.';
  if (segments.some(segment => !segment)) return result;
  const toRate = period => DAY_SECONDS * (expected / period - 1);
  const rates = segments.map(segment => toRate(segment.period));
  result.segmentRates = rates.slice(1);
  result.spread = Math.max(...segments.map(segment => segment.spread),
    Math.abs(rates[1] - rates[2]), ...rates.map(rate => Math.abs(rate - rates[0])));
  result.correlation = Math.min(...segments.map(segment => segment.correlation));
  result.quality = RateQuality.Unsteady;
  result.reason = `Waveform estimates disagree by about ${Math.ceil(result.spread)} s/day across lags or separate halves. Keep the setup still and repeat.`;
  if (result.spread > USABLE_SPREAD) return result;
  result.rate = rates[0];
  result.period = segments[0].period / 2;
  result.bph = HOUR_SECONDS / result.period;
  result.quality = result.spread <= STABLE_SPREAD ? RateQuality.Stable : RateQuality.Usable;
  result.reason = 'Average rate from full-cycle envelope correlation. Beat error and amplitude need separate pulse checks.';
  return result;
}
