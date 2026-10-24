import fs from 'node:fs';
import vm from 'node:vm';
import {InputChannel,selectChannel} from './dist/channels.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, parseWav, chooseRate } from './dist/capture.mjs';

test('a saved take keeps its native sample rate and signed audio', () => {
  const audio = Float32Array.from([0, -0.5, 0.25, 0.99, -1]);
  const saved = encodeWav(audio, 96000);
  const read = parseWav(saved);
  assert.equal(read.sampleRate, 96000);
  assert.equal(read.sourceRateKnown, true);
  assert.equal(read.samples.length, audio.length);
  audio.forEach((value, index) => assert.ok(Math.abs(read.samples[index] - value) < 0.00005));
});

test('a truncated WAV is rejected instead of producing misleading samples', () => {
  const saved = encodeWav(new Float32Array(100), 48000);
  assert.throws(() => parseWav(saved.slice(0, 50)), /truncated/i);
});

test('unsupported files defer to browser decoding', () => {
  assert.equal(parseWav(new ArrayBuffer(20)), null);
});

test('highest rate respects the input capability and never claims an upsample', () => {
  assert.equal(chooseRate('max', {sampleRate: {max:48000}}), 48000);
  assert.equal(chooseRate('max', {sampleRate: {max:384000}}), 384000);
  assert.equal(chooseRate('96000', {sampleRate: {max:48000}}), 48000);
  assert.equal(chooseRate('max', {}), 192000);
});


// Opposite polarity exposes accidental averaging even when the signal looks loud.
test('stereo WAV imports retain each input and mix only on request', () => {
  const buffer = new ArrayBuffer(44 + 8);
  const mono = new Uint8Array(encodeWav(new Float32Array(4), 48000));
  new Uint8Array(buffer).set(mono);
  const view = new DataView(buffer);
  view.setUint16(22, 2, true);
  view.setUint32(28, 48000 * 4, true);
  view.setUint16(32, 4, true);
  for (let i = 0; i < 2; i++) {
    view.setInt16(44 + i * 4, 16384, true);
    view.setInt16(46 + i * 4, -16384, true);
  }
  const first = parseWav(buffer);
  assert.deepEqual([...first.samples], [0.5, 0.5]);
  assert.deepEqual([...parseWav(buffer, InputChannel.Second).samples], [-0.5, -0.5]);
  assert.deepEqual([...parseWav(buffer, InputChannel.Mix).samples], [0, 0]);
  assert.equal(first.audioChannels.length, 2);
});

test('Input 2 falls back to the sole channel for mono devices', () => {
  const mono = Float32Array.from([0.5, -0.5]);
  assert.equal(selectChannel([mono], InputChannel.Second), mono);
});

test('live worklet preserves selected input and contiguous frame positions', () => {
  let Processor;
  const packets = [];
  const scope = {
    AudioWorkletProcessor: class { port = {postMessage: packet => packets.push(packet)}; },
    registerProcessor: (name, processor) => { Processor = processor; },
    InputChannel, selectChannel, Float32Array, Math, currentFrame: 0,
  };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(new URL('./dist/capture-worklet.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, ''), scope);
  const processor = new Processor({processorOptions:{selection:InputChannel.Second}});
  const first = new Float32Array(128).fill(0.5);
  const second = new Float32Array(128).fill(-0.25);
  for(let block=0;block<128;block++) {
    scope.currentFrame = block * 128;
    processor.process([[first, second]]);
  }
  assert.equal(packets.length, 2);
  assert.deepEqual(packets.map(packet => packet.frame), [0, 8192]);
  assert.ok(new Float32Array(packets[0].samples).every(value => value === -0.25));
  assert.ok(Math.abs(packets[0].levels[0] + 6.0206) < 0.001);
  assert.ok(Math.abs(packets[0].levels[1] + 12.0412) < 0.001);
  assert.deepEqual(packets[1].levels, packets[0].levels);
});
