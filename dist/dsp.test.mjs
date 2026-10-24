import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, amplitudeFromLift, makeDemo } from './dsp.mjs';

const SAMPLE_RATE = 48000;
const OPTIONS = { bph: 21600, lowHz: 1200, highHz: 10000 };
const close = (value, expected, tolerance, label) => {
  assert.ok(Number.isFinite(value), `${label} must be finite: ${value}`);
  assert.ok(Math.abs(value - expected) <= tolerance,
    `${label}: ${value}, expected ${expected} ± ${tolerance}`);
};

test('silence and ambient noise never become a zero-rate watch', () => {
  for (const signal of [new Float32Array(SAMPLE_RATE * 20),
    makeDemo({ seconds: 20, sampleRate: SAMPLE_RATE, noiseOnly: true, noise: 0.03 })]) {
    const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
    assert.equal(reading.rate, null);
    assert.equal(reading.average?.rate ?? null, null);
    assert.equal(reading.bph, null);
    assert.equal(reading.beatError, null);
    assert.notEqual(reading.quality, 'stable');
  }
});

for (const rate of [-900, -120, 120]) {
  test(`multicomponent acoustic pulses retain the rate sign at ${rate} s/day`, () => {
    const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate, beatError: 1.2 });
    const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
    close(reading.rate, rate, 4, 'rate');
    close(reading.bph, 21600 * (1 + rate / 86400), 1.1, 'measured BPH');
    close(reading.beatError, 1.2, 0.2, 'half alternating-interval difference');
    assert.ok(reading.coverage > 0.95);
    assert.equal(reading.quality, 'stable');
    assert.ok(reading.fold.tick.length > 100);
    assert.ok(reading.fold.tock.length > 100);
  });
}

test('missing beats reduce coverage without changing measured rate', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate: -900,
    missingEvery: 6, doubleEvery: 9, noise: 0.008 });
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  close(reading.rate, -900, 8, 'rate with missing beats');
  assert.ok(reading.coverage < 0.9 && reading.coverage > 0.65);
  assert.notEqual(reading.quality, 'stable');
});

test('clipping blocks adjustment-quality feedback', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, gain: 12 });
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  assert.ok(reading.clippedRatio > 0.001);
  assert.equal(reading.quality, 'noisy');
});

test('fewer than six seconds cannot produce adjustment feedback', () => {
  const signal = makeDemo({ seconds: 3, sampleRate: SAMPLE_RATE });
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  assert.equal(reading.rate, null);
  assert.equal(reading.quality, 'waiting');
});

test('calibration scales the audio clock with an explicit sign', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate: 0 });
  const raw = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  const corrected = analyzeAudio(signal, SAMPLE_RATE, { ...OPTIONS, calibrationPpm: 100 });
  close(corrected.rate - raw.rate, 8.64, 0.05, 'positive effective sample-rate correction');
});

test('amplitude uses full oscillation period, including the factor of two', () => {
  close(amplitudeFromLift(53, 10, 1000 / 6), 281.596, 0.01, 'amplitude');
  assert.equal(amplitudeFromLift(53, 0, 1000 / 6), null);
  assert.equal(amplitudeFromLift(53, 180, 1000 / 6), null);
});

test('both folded sides preserve manually identifiable lift time', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: 96000, rate: 0, liftMs: 10 });
  const reading = analyzeAudio(signal, 96000, OPTIONS);
  const { fold } = reading;
  const peakTime = (curve, min, max) => {
    let strength = -Infinity, time = 0;
    for (let i = 0; i < curve.length; i++) {
      const position = fold.startMs + i * fold.stepMs;
      if (position < min || position > max || curve[i] <= strength) continue;
      strength = curve[i]; time = position;
    }
    return time;
  };
  for (const curve of [fold.tick, fold.tock]) {
    const lift = peakTime(curve, -1, 1) - peakTime(curve, -12, -8);
    close(lift, 10, 0.15, 'manual pulse separation');
    close(amplitudeFromLift(53, lift, reading.period * 1000), 281.596, 4, 'fold-derived amplitude');
  }
});

test('different acoustic pulse shapes cannot claim mechanical beat-error certainty', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate: -900,
    beatError: 1.2, tickLiftMs: 8, tockLiftMs: 10 });
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  close(reading.rate, -900, 4, 'rate independent of alternating shape');
  close(reading.beatError, 3.2, 0.2, 'provisional drop-pulse offset');
  assert.equal(reading.beatErrorReliable, false);
});

test('192 kHz capture retains raw clipping statistics and repeatable timing', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: 192000, rate: -900 });
  const reading = analyzeAudio(signal, 192000, OPTIONS);
  close(reading.rate, -900, 4, '192 kHz rate');
  assert.equal(reading.clippedRatio, 0);
  assert.ok(reading.peak > 0.4);
});

test('a clean single audible side gives rate without invented beat error', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate: -900,
    missingEvery: 2 });
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  close(reading.rate, -900, 4, 'one-sided rate');
  close(reading.bph, 21375, 1.1, 'BPH inferred from full cycles');
  assert.equal(reading.quality, 'stable');
  assert.equal(reading.oneSided, true);
  assert.equal(reading.beatError, null);
  assert.equal(reading.fold, undefined);
  assert.match(reading.reason, /one side.*rate only/i);
});

test('a short single-sided train cannot become a stable adjustment baseline', () => {
  const signal = makeDemo({ seconds: 12, sampleRate: SAMPLE_RATE, missingEvery: 2 });
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  assert.equal(reading.rate, null);
  assert.notEqual(reading.quality, 'stable');
});

function addRoomPulse(samples, time, strength) {
  const centre = Math.round(time * SAMPLE_RATE);
  const radius = Math.ceil(SAMPLE_RATE * 0.0015);
  for (let i = Math.max(0, centre - radius); i < Math.min(samples.length, centre + radius); i++) {
    const t = (i - centre) / SAMPLE_RATE;
    samples[i] += strength * Math.exp(-0.5 * (t / 0.00025) ** 2) * Math.sin(2 * Math.PI * 4600 * t);
  }
}

test('one louder off-phase room knock cannot choose the watch phase', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate: -900 });
  addRoomPulse(signal, 10.18, 0.9);
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  close(reading.rate, -900, 4, 'rate under one louder off-phase knock');
  assert.ok(reading.coverage > 0.95);
});

test('a chain of late pulses cannot merge a whole beat into its loudest artifact', () => {
  const signal = makeDemo({ seconds: 24, sampleRate: SAMPLE_RATE, rate: -900 });
  const period = (1 / 6) / (1 - 900 / 86400);
  for (let beat = 0; 0.15 + beat * period < 24; beat++) {
    const time = 0.15 + beat * period + (beat % 2 ? 0.0012 : 0);
    for (let pulse = 0; pulse < 5; pulse++) {
      addRoomPulse(signal, time + 0.024 * (pulse + 1), pulse === beat % 5 ? 0.8 : 0.05);
    }
  }
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  close(reading.rate, -900, 4, 'rate under varying late pulse strength');
  assert.ok(reading.coverage > 0.7);
});

test('a coherent fragment cannot hide that the watch stopped for most of a take', () => {
  const signal = new Float32Array(60 * SAMPLE_RATE);
  signal.set(makeDemo({ seconds: 20, sampleRate: SAMPLE_RATE, rate: -900 }));
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  assert.notEqual(reading.quality, 'stable');
  assert.equal(reading.average.rate, null);
  assert.ok(reading.coverage < 0.4, 'Coverage includes missing time before and after matched events');
});

test('a sustained carrier in less than half a take cannot alias into watch ticks', () => {
  const signal = new Float32Array(60 * SAMPLE_RATE);
  for (let i = 0; i < 24 * SAMPLE_RATE; i++) signal[i] = 0.35 * Math.sin(2 * Math.PI * 4200 * i / SAMPLE_RATE);
  const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
  assert.equal(reading.rate, null);
  assert.equal(reading.average.rate, null);
  assert.notEqual(reading.quality, 'stable');
});

test('period search does not invent a watch from random room transients', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const signal = makeDemo({ seconds: 36, sampleRate: SAMPLE_RATE, noiseOnly: true, seed });
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let time = 0.1; time < 36; time += 0.02 - 0.045 * Math.log(Math.max(1e-9, random()))) {
      addRoomPulse(signal, time, 0.03 + random() * 0.3);
    }
    const reading = analyzeAudio(signal, SAMPLE_RATE, OPTIONS);
    assert.equal(reading.rate, null, `Random transient seed ${seed}`);
    assert.equal(reading.average.rate, null, `Waveform transient seed ${seed}`);
    assert.notEqual(reading.quality, 'stable');
  }
});

test('waveform averaging provides independent rate confidence through extra pulses', () => {
  const reading = analyzeAudio(makeDemo({seconds:60,sampleRate:SAMPLE_RATE,rate:24,doubleEvery:3}), SAMPLE_RATE, OPTIONS);
  assert.notEqual(reading.quality, 'stable');
  assert.equal(reading.average.quality, 'stable');
  close(reading.average.rate, 24, 2, 'waveform average');
  assert.equal(reading.beatError, null);
});
