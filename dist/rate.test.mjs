import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRate, RateQuality } from './rate.mjs';

const SAMPLE_RATE = 2000;
const BPH = 21600;
const DAY_SECONDS = 86400;

function envelope(options = {}) {
  const seconds = options.seconds ?? 60;
  const values = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let seed = 7009;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < values.length; i++) values[i] = 0.01 + random() * (options.noise ?? 0.01);
  let time = 0.15, beat = 0;
  while (time < seconds) {
    const rate = time < seconds / 2 ? options.rate ?? 24 : options.secondRate ?? options.rate ?? 24;
    const period = 3600 / BPH / (1 + rate / DAY_SECONDS);
    if (!options.noiseOnly && !(options.missingEvery && beat % options.missingEvery === 0)) {
      // The loudest pulse alternates between two places within each beat.
      const shift = options.shapeChanges ? (random() > 0.5 ? 0.008 : 0) : 0;
      for (const [offset, strength] of [[0, 0.1], [0.008, 0.1], [shift, 0.3]]) {
        const centre = Math.round((time + offset + (beat % 2 ? 0.002 : 0)) * SAMPLE_RATE);
        for (let i = Math.max(0, centre - 4); i < Math.min(values.length, centre + 5); i++) {
          values[i] += strength * Math.exp(-0.5 * ((i - centre) / 1.5) ** 2);
        }
      }
    }
    time += period; beat++;
  }
  return values;
}

for (const rate of [-900, 0, 24, 1800]) {
  test(`correlation measures ${rate} s/day without assuming nominal cadence`, () => {
    const value = estimateRate(envelope({ rate }), SAMPLE_RATE, BPH);
    assert.equal(value.quality, RateQuality.Stable, JSON.stringify(value));
    assert.ok(Math.abs(value.rate - rate) < 4, JSON.stringify(value));
    assert.ok(value.spread < 20);
  });
}

test('changing strongest peaks can retain average rate without clean pulse timing', () => {
  const value = estimateRate(envelope({ shapeChanges: true }), SAMPLE_RATE, BPH);
  assert.equal(value.quality, RateQuality.Stable, JSON.stringify(value));
  assert.ok(Math.abs(value.rate - 24) < 10, JSON.stringify(value));
});

test('separate halves veto a changing cadence', () => {
  const value = estimateRate(envelope({ rate: 1500, secondRate: 2500 }), SAMPLE_RATE, BPH);
  assert.equal(value.rate, null);
  assert.ok([RateQuality.Unsteady, RateQuality.Searching].includes(value.quality));
});

test('noise and a partly silent recording cannot become a stable average', () => {
  const noise = envelope({ noiseOnly: true });
  const partial = envelope(); partial.fill(0, SAMPLE_RATE * 20);
  for (const input of [noise, partial, new Float32Array(SAMPLE_RATE * 60)]) {
    const value = estimateRate(input, SAMPLE_RATE, BPH);
    assert.equal(value.rate, null, JSON.stringify(value));
    assert.notEqual(value.quality, RateQuality.Stable);
  }
});

test('missing beats retain rate when rhythm persists through both halves', () => {
  const value = estimateRate(envelope({ missingEvery: 6 }), SAMPLE_RATE, BPH);
  assert.ok([RateQuality.Usable, RateQuality.Stable].includes(value.quality), JSON.stringify(value));
  assert.ok(Math.abs(value.rate - 24) < 8, JSON.stringify(value));
});

test('smooth amplitude modulation is not enough to identify a watch rhythm', () => {
  const values = Float32Array.from({length:SAMPLE_RATE*60}, (_,index) => 1 + 0.5*Math.sin(2*Math.PI*3*index/SAMPLE_RATE));
  const value = estimateRate(values, SAMPLE_RATE, BPH);
  assert.equal(value.rate, null);
});
