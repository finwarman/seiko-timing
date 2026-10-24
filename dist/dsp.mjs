// Acoustic timing estimates, not a calibrated watchmaker's instrument.
// Rate uses independent tick/tock intercepts and a shared long-term slope.
import { estimateRate } from './rate.mjs';

export const Quality = Object.freeze({
  Waiting: 'waiting', Weak: 'weak', Noisy: 'noisy', Usable: 'usable', Stable: 'stable',
});

const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;
const ENVELOPE_RATE = 12000;
const MIN_DURATION = 6;
const CLIP_LIMIT = 0.001;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

function coefficients(frequency, sampleRate, sign) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / Math.SQRT2;
  const scale = 1 + alpha;
  const first = (1 + sign * cosine) / (2 * scale);
  return [first, -sign * 2 * first, first, -2 * cosine / scale, (1 - alpha) / scale];
}

function makeEnvelope(samples, sampleRate, lowHz, highHz) {
  const block = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE));
  const count = Math.floor(samples.length / block);
  const envelope = new Float32Array(count);
  const hp = coefficients(lowHz, sampleRate, 1);
  const lp = coefficients(highHz, sampleRate, -1);
  let h1 = 0, h2 = 0, l1 = 0, l2 = 0;
  let sum = 0, peak = 0, clipped = 0, energy = 0, frame = 0;

  // Raw peak, RMS and clipping always describe the unfiltered native samples.
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0;
    const absolute = Math.abs(value);
    peak = Math.max(peak, absolute);
    sum += value * value;
    if (absolute >= 0.995) clipped++;

    const high = hp[0] * value + h1;
    h1 = hp[1] * value - hp[3] * high + h2;
    h2 = hp[2] * value - hp[4] * high;
    const filtered = lp[0] * high + l1;
    l1 = lp[1] * high - lp[3] * filtered + l2;
    l2 = lp[2] * high - lp[4] * filtered;
    energy += filtered * filtered;

    if ((i + 1) % block === 0 && frame < count) {
      envelope[frame++] = Math.sqrt(energy / block);
      energy = 0;
    }
  }

  // A centred short average suppresses carrier ripple without shifting pulses.
  const smooth = new Float32Array(count);
  for (let i = 1; i < count - 1; i++) {
    smooth[i] = (envelope[i - 1] + envelope[i] + envelope[i + 1]) / 3;
  }
  return { envelope: smooth, block, peak, rms: Math.sqrt(sum / Math.max(1, samples.length)),
    clippedRatio: clipped / Math.max(1, samples.length) };
}

function findBursts(envelope, frameRate, threshold) {
  const distribution = [];
  const stride = Math.max(1, Math.floor(envelope.length / 8000));
  for (let i = 0; i < envelope.length; i += stride) distribution.push(envelope[i]);
  distribution.sort((a, b) => a - b);
  const floor = quantile(distribution, 0.5);
  const spread = (quantile(distribution, 0.75) - quantile(distribution, 0.25)) / 1.35;
  const gate = Math.max(1e-7, floor * threshold, floor + threshold * spread);
  const bursts = [];
  const groupFrames = frameRate * 0.035;
  let groupStart = -Infinity;

  // Unlock, impulse and drop belong to one beat, not three separate beats.
  for (let i = 1; i < envelope.length - 1; i++) {
    const value = envelope[i];
    if (value < gate || value < envelope[i - 1] || value <= envelope[i + 1]) continue;
    const previous = bursts.at(-1);
    if (previous && i - groupStart < groupFrames) {
      if (value > previous.strength) {
        previous.frame = i;
        previous.strength = value;
      }
    } else {
      bursts.push({ frame: i, strength: value });
      groupStart = i;
    }
  }
  return { bursts, floor, gate };
}

function fitParity(events) {
  const sums = [{ n: 0, x: 0, y: 0 }, { n: 0, x: 0, y: 0 }];
  for (const event of events) {
    const sum = sums[((event.index % 2) + 2) % 2];
    sum.n++; sum.x += event.index; sum.y += event.time;
  }
  const populated = sums.filter(sum => sum.n > 0);
  if (!populated.length || populated.some(sum => sum.n < 4)) return null;
  let xy = 0, xx = 0;
  for (const event of events) {
    const sum = sums[((event.index % 2) + 2) % 2];
    const x = event.index - sum.x / sum.n;
    xy += x * (event.time - sum.y / sum.n);
    xx += x * x;
  }
  if (xx === 0) return null;
  const period = xy / xx;
  const intercepts = sums.map(sum => sum.n ? (sum.y - period * sum.x) / sum.n : null);
  return { period, intercepts, sides: populated.length };
}

function residual(event, fit) {
  const parity = ((event.index % 2) + 2) % 2;
  return event.time - fit.intercepts[parity] - event.index * fit.period;
}

function fitCandidate(candidates, estimate, anchor) {
  const grid = new Map();
  for (const event of candidates) {
    const index = Math.round((event.time - anchor.time) / estimate);
    if (Math.abs(event.time - anchor.time - index * estimate) > estimate * 0.24) continue;
    const previous = grid.get(index);
    if (!previous || event.strength > previous.strength) grid.set(index, { ...event, index });
  }
  let events = [...grid.values()].sort((a, b) => a.index - b.index);
  let fit = fitParity(events);
  if (!fit) return null;

  // Revisit all pulses after fitting. A loud artifact must not permanently hide
  // a quieter on-time click at the same beat index.
  for (let iteration = 0; iteration < 3; iteration++) {
    for (let side = 0; side < 2; side++) {
      if (fit.intercepts[side] === null) continue;
      const offsets = events.filter(event => ((event.index % 2) + 2) % 2 === side)
        .map(event => residual(event, fit));
      fit.intercepts[side] += median(offsets);
    }
    const errors = events.map(event => Math.abs(residual(event, fit)));
    const limit = Math.min(estimate * 0.1, Math.max(0.0007, median(errors) * 1.4826 * 4.5));
    const selected = new Map();
    for (const event of candidates) {
      let closest = null;
      for (let side = 0; side < 2; side++) {
        const intercept = fit.intercepts[side];
        if (intercept === null) continue;
        const index = 2 * Math.round((event.time - intercept - side * fit.period) / (2 * fit.period)) + side;
        const error = Math.abs(event.time - intercept - index * fit.period);
        if (error <= limit && (!closest || error < closest.error)) closest = { ...event, index, error };
      }
      if (!closest) continue;
      const previous = selected.get(closest.index);
      if (!previous || closest.error < previous.error) selected.set(closest.index, closest);
    }
    events = [...selected.values()].sort((a, b) => a.index - b.index);
    fit = fitParity(events);
    if (!fit || events.length < 16) return null;
  }
  const span = events.at(-1).index - events[0].index + 1;
  const coverage = events.length / (fit.sides === 1 ? Math.ceil(span / 2) : span);
  const jitterMs = 1000 * Math.sqrt(events.reduce((sum, event) => sum + residual(event, fit) ** 2, 0) / events.length);
  return { events, fit, coverage, jitterMs };
}

function lockRhythm(bursts, frameRate, expected) {
  if (bursts.length < 16) return null;
  const candidates = bursts.map(event => ({ ...event, time: (event.frame + 0.5) / frameRate }));
  const periods = [];
  for (let lag = 1; lag <= 12; lag++) {
    for (let i = lag; i < candidates.length; i++) {
      const gap = candidates[i].time - candidates[i - lag].time;
      const beats = Math.round(gap / expected);
      // Even lags compare the same acoustic side and cancel beat error.
      if (beats < 2 || beats > 12 || beats % 2) continue;
      const estimate = gap / beats;
      if (Math.abs(estimate / expected - 1) < 0.12) periods.push(estimate);
    }
  }
  if (periods.length < 12) return null;

  // Keep several independently supported period candidates. Ambient pulses can
  // bias a global median; one loud knock can choose the wrong global phase.
  const binWidth = expected / 2000;
  const histogram = new Map();
  for (const period of periods) {
    const key = Math.round(period / binWidth);
    const bin = histogram.get(key) ?? [];
    bin.push(period); histogram.set(key, bin);
  }
  const bins = [...histogram.entries()].sort((a, b) => b[1].length - a[1].length);
  const seeds = [median(periods)];
  for (const [key, values] of bins) {
    const seed = median(values);
    if (seeds.every(previous => Math.abs(previous - seed) > 2 * binWidth)) seeds.push(seed);
    if (seeds.length >= 8) break;
  }
  const anchors = candidates.filter((event, index) => index % Math.max(1, Math.floor(candidates.length / 12)) === 0);
  anchors.push(...candidates.slice(0, 12));
  anchors.push(candidates.reduce((best, event) => event.strength > best.strength ? event : best));
  let best = null;
  for (const seed of seeds) {
    for (const anchor of anchors) {
      const model = fitCandidate(candidates, seed, anchor);
      if (!model) continue;
      const score = model.events.length / (1 + model.jitterMs);
      if (!best || score > best.score) best = { ...model, score };
    }
  }
  return best;
}

function makeFold(envelope, events, frameRate, floor) {
  const groups = [[], []];
  for (const event of events) groups[((event.index % 2) + 2) % 2].push(event);
  if (groups.some(group => group.length < 20)) return undefined;
  const startMs = -25;
  const stepMs = 1000 / frameRate;
  const length = Math.floor(37 / stepMs) + 1;
  const curves = groups.map(group => {
    const curve = new Array(length).fill(0);
    let count = 0;
    for (const event of group) {
      const start = event.frame + startMs * frameRate / 1000;
      if (start < 0 || start + length >= envelope.length) continue;
      count++;
      for (let i = 0; i < length; i++) {
        const position = start + i;
        const left = Math.floor(position);
        const fraction = position - left;
        curve[i] += envelope[left] * (1 - fraction) + envelope[left + 1] * fraction;
      }
    }
    return curve.map(value => value / Math.max(1, count));
  });
  const maximum = Math.max(...curves[0], ...curves[1], 1e-9);
  return { tick: curves[0].map(value => value / maximum),
    tock: curves[1].map(value => value / maximum), startMs, stepMs,
    count: events.length, noiseFloor: floor / maximum };
}

/** Times are seconds from the input's start. period is one beat interval in seconds.
 * calibrationPpm increases the effective ADC sample rate; +100 adds about +8.64 s/day.
 * Tick/tock names identify parity only. They are not identified physical pallet sides.
 */
export function analyzeAudio(samples, sampleRate, options = {}) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new TypeError('Provide Float32Array audio and a native sample rate of at least 8000 Hz.');
  }
  const bph = Number(options.bph) || 21600;
  const correction = 1 + (Number(options.calibrationPpm) || 0) / 1e6;
  const effectiveRate = sampleRate * correction;
  const lowHz = Math.max(100, Math.min(Number(options.lowHz) || 1200, sampleRate * 0.35));
  const highHz = Math.max(lowHz + 100, Math.min(Number(options.highHz) || 10000, sampleRate * 0.45));
  const capture = makeEnvelope(samples, sampleRate, lowHz, highHz);
  const frameRate = effectiveRate / capture.block;
  const { bursts, floor } = findBursts(capture.envelope, frameRate, Math.max(2, Number(options.threshold) || 5));
  const reading = {
    duration: samples.length / sampleRate, peak: capture.peak, rms: capture.rms,
    clippedRatio: capture.clippedRatio, events: [], rate: null, bph: null,
    beatError: null, beatErrorReliable: false, beatErrorProvisional: true,
    quality: Quality.Waiting, snrDb: 0, coverage: 0, jitterMs: 0,
    reason: 'Collect at least six seconds of stationary watch sound.', period: null, oneSided: false,
    average: capture.clippedRatio <= CLIP_LIMIT ? estimateRate(capture.envelope, frameRate, bph) : null,
  };
  if (reading.duration < MIN_DURATION) return reading;
  reading.quality = Quality.Weak;
  reading.reason = 'No repeatable watch rhythm. Improve microphone contact or reduce noise.';
  const lock = lockRhythm(bursts, frameRate, HOUR_SECONDS / bph);
  if (!lock) return reading;
  const { events, fit, jitterMs } = lock;
  const totalSlots = Math.floor((samples.length / effectiveRate) / fit.period);
  const audibleSlots = fit.sides === 1 ? Math.ceil(totalSlots / 2) : totalSlots;
  // Coverage includes quiet time at both ends, not only the selected fragment.
  const coverage = Math.min(lock.coverage, events.length / Math.max(1, audibleSlots));
  reading.coverage = coverage;
  reading.jitterMs = jitterMs;
  reading.snrDb = 20 * Math.log10(Math.max(1, median(events.map(event => event.strength)) / Math.max(floor, 1e-9)));
  reading.events = events.map(({ time, strength }) => ({ time, strength }));
  reading.oneSided = fit.sides === 1;
  if (coverage < 0.55 || reading.snrDb < 10 || jitterMs > 4) return reading;
  if (reading.oneSided && (reading.duration < 18 || events.length < 48 ||
      coverage < 0.93 || jitterMs > 0.5 || reading.snrDb < 20)) {
    reading.reason = 'One side may be audible. Collect at least eighteen seconds of repeatable clicks.';
    return reading;
  }
  reading.period = fit.period;
  reading.bph = HOUR_SECONDS / fit.period;
  reading.rate = DAY_SECONDS * (reading.bph / bph - 1);
  reading.fold = makeFold(capture.envelope, events, frameRate, floor);

  // Different tick/tock acoustic shapes can bias this value. Manual unlock-pulse
  // identification is needed before interpreting it as mechanical beat error.
  if (!reading.oneSided && coverage >= 0.7 && jitterMs <= 1 && reading.snrDb >= 15 && capture.clippedRatio <= CLIP_LIMIT) {
    const difference = fit.intercepts[1] - fit.intercepts[0];
    reading.beatError = 1000 * Math.abs(difference - Math.round(difference / fit.period) * fit.period);
  }

  if (capture.clippedRatio > CLIP_LIMIT) {
    reading.quality = Quality.Noisy;
    reading.reason = 'Input is clipping. Reduce microphone gain and measure again.';
    return reading;
  }
  if (jitterMs > 2 || reading.snrDb < 15) {
    reading.quality = Quality.Noisy;
    reading.reason = 'Timing is scattered. Keep the watch still and improve microphone contact.';
    return reading;
  }
  reading.quality = Quality.Usable;
  reading.reason = coverage < 0.93
    ? 'Some beats are missing. Improve contact before using adjustment guidance.'
    : 'Rhythm detected. Keep the setup still while the reading settles.';
  const minimumEvents = reading.oneSided ? 48 : 80;
  if (reading.duration >= 18 && events.length >= minimumEvents && coverage >= 0.93 && jitterMs <= 0.5) {
    reading.quality = Quality.Stable;
    reading.reason = reading.oneSided
      ? 'Only one side is audible; rate only. BPH is inferred from the expected full-cycle cadence.'
      : 'Repeatable acoustic timing. Confirm it in another stationary measurement.';
  }
  return reading;
}

/** Harmonic-balance estimate. beatPeriodMs is tick-to-tock, not tick-to-tick.
 * A = liftAngle / (2 sin(pi * liftTime / fullOscillationPeriod)).
 * No amplitude value is inferred from loudness or the six-Hz repetition frequency.
 */
export function amplitudeFromLift(liftAngle, liftMs, beatPeriodMs) {
  if (![liftAngle, liftMs, beatPeriodMs].every(Number.isFinite) ||
      liftAngle <= 0 || liftAngle >= 180 || liftMs <= 0 || liftMs >= beatPeriodMs) return null;
  return liftAngle / (2 * Math.sin(Math.PI * liftMs / (2 * beatPeriodMs)));
}

/** Deterministic synthetic audio for checking the pipeline, not a real watch sample. */
export function makeDemo(options = {}) {
  const sampleRate = options.sampleRate || 96000;
  const seconds = options.seconds || 24;
  const bph = options.bph || 21600;
  const rate = options.rate ?? -900;
  const beatError = (options.beatError ?? 1.2) / 1000;
  const lifts = [(options.tickLiftMs ?? options.liftMs ?? 6) / 1000,
    (options.tockLiftMs ?? options.liftMs ?? 6) / 1000];
  const noise = options.noise ?? 0.003;
  const gain = options.gain ?? 1;
  const result = new Float32Array(Math.ceil(seconds * sampleRate));
  let seed = (options.seed ?? 7009) >>> 0;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < result.length; i++) {
    // Sum uniforms for bounded, noise-like input without nondeterministic RNG.
    result[i] = noise * (random() + random() + random() - 1.5);
  }
  const addPulse = (time, strength, width = 0.00028) => {
    const centre = Math.round(time * sampleRate);
    const radius = Math.ceil(width * 4 * sampleRate);
    for (let i = Math.max(0, centre - radius); i < Math.min(result.length, centre + radius); i++) {
      const relative = (i - centre) / sampleRate;
      const envelope = Math.exp(-0.5 * (relative / width) ** 2);
      result[i] += strength * envelope * (Math.sin(2 * Math.PI * 4200 * relative) +
        0.45 * Math.sin(2 * Math.PI * 7300 * relative));
    }
  };
  const period = (HOUR_SECONDS / bph) / (1 + rate / DAY_SECONDS);
  if (!options.noiseOnly) {
    for (let beat = 0; 0.15 + beat * period < seconds; beat++) {
      if (options.missingEvery && beat % options.missingEvery === options.missingEvery - 1) continue;
      const start = 0.15 + beat * period + (beat % 2 ? beatError : 0);
      const lift = lifts[beat % 2];
      addPulse(start, 0.10);
      addPulse(start + lift * 0.52, 0.075);
      addPulse(start + lift, beat % 2 ? 0.30 : 0.34);
      if (options.doubleEvery && beat % options.doubleEvery === 0) addPulse(start + 0.022, 0.40);
    }
  }
  for (let i = 0; i < result.length; i++) result[i] = Math.max(-1, Math.min(1, result[i] * gain));
  return result;
}
