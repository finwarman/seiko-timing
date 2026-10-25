import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analyzeAudio, amplitudeFromLift, makeDemo, Quality } from './dist/dsp.mjs';
import { RateQuality } from './dist/rate.mjs';
import { createAnalyzer, TimingEngine, HistoryMode, FilterMode } from './dist/watch-engine.mjs';
import { InputChannel, selectChannel, channelLevels } from './dist/channels.mjs';
import { timingStrip } from './dist/timing-strip.mjs';
import { drawVintageMeter } from './dist/vintage-meter.mjs';
import { vintageSweep } from './dist/vintage-sweep.mjs';
import { StableHistory, drawStableHistory } from './dist/stable-history.mjs';

const Job = Object.freeze({ Analyze: 'analyze', Demo: 'demo' });
const EMPTY = String.fromCodePoint(0x2013);
const NATIVE_RATE = 48000;
const appCode = fs.readFileSync(new URL('./dist/app.mjs', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8');
const watchAudio = makeDemo({ seconds: 36, sampleRate: NATIVE_RATE, rate: 24, liftMs: 10 });
const tgAnalyzer = await createAnalyzer(fs.readFileSync(new URL('./dist/vendor/tg/tg-core.wasm',import.meta.url)));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function makeElement(attributes = {}) {
  const listeners = new Map();
  const canvas = new Proxy({
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  }, { get: (target, key) => target[key] ?? (() => {}) });
  return {
    value: '', checked: false, hidden: false, disabled: false, textContent: '',
    dataset: {}, style: {}, options: [], ...attributes,
    classList: { toggle() {}, add() {}, remove() {} },
    get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN; },
    get validity() {
      const number = this.valueAsNumber;
      const invalid = this.value !== '' && (!Number.isFinite(number) ||
        (this.min !== undefined && number < Number(this.min)) ||
        (this.max !== undefined && number > Number(this.max)));
      return { valid: !invalid, rangeUnderflow: number < Number(this.min), rangeOverflow: number > Number(this.max) };
    },
    checkValidity() { return this.validity.valid; }, reportValidity() { return this.checkValidity(); },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback); listeners.set(type, callbacks);
    },
    fire(type, detail = {}) {
      return (listeners.get(type) ?? []).map(callback => callback({ target: this, ...detail }));
    },
    getBoundingClientRect: () => ({ width: 1, height: 1 }),
    getContext: () => canvas,
    replaceChildren() {}, append() {}, add(option) { this.options.push(option); },
    setAttribute(key, value) { this[key] = value; },
    getAttribute(key) { return this[key] ?? null; },
    removeAttribute(key) { delete this[key]; },
    click() { this.fire('click'); },
  };
}

function makeHarness() {
  const elements = new Map();
  const errors = [];
  const microphones = [];
  const intervals=[];
  let now=0;
  const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const values = attributes(match[1]);
    if (values.id) elements.set(values.id, makeElement(values));
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const values = attributes(match[1]);
    const options = [...match[2].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
    const selected = options.find(option => /\bselected\b/.test(option[1])) ?? options[0];
    values.value = selected ? attributes(selected[1]).value ?? selected[2] : '';
    if (values.id) elements.set(values.id, makeElement(values));
  }
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement({ id }));
    return elements.get(id);
  };
  let worker;
  class FakeWorker {
    constructor(url) {
      if (url === 'analysis-worker.mjs') worker = this;
      this.requests = []; this.pending = new Map();
    }
    postMessage(request) { this.requests.push(request); this.pending.set(request.id, request); }
    next(type) { return [...this.pending.values()].find(request => request.type === type); }
    answer(request, payload) {
      assert.ok(request, 'Expected a worker request');
      this.pending.delete(request.id);
      this.onmessage({ data: { id: request.id, ...payload } });
    }
    analyze(request = this.next(Job.Analyze)) {
      const result = analyzeAudio(request.samples, request.sampleRate, request.options);
      this.answer(request, { result });
      return result;
    }
    demo(request = this.next(Job.Demo)) {
      this.answer(request, { samples: watchAudio.slice(), sampleRate: NATIVE_RATE });
    }
  }
  class FakeMic {
    constructor(onSamples) { this.push=onSamples;this.stopped = false; microphones.push(this); }
    async start(deviceId, rate, channel) {
      this.selection = {deviceId, rate, channel};
      return { processingRate: NATIVE_RATE, captureRate: NATIVE_RATE, requestedRate: 192000,
        label: 'Fixture microphone', settings: { noiseSuppression: false, autoGainControl: false, echoCancellation: false } };
    }
    async stop() { this.stopped = true; }
    setBand() {}
  }
  const sandbox = {
    console, Float32Array, Float64Array, Uint8ClampedArray, Map, Promise, Math, Number,
    String, Object, Array, Date, Error, Blob, URL, setTimeout, clearTimeout,
    setInterval: callback=>intervals.push(callback),
    performance: { now: () => now }, crypto: { randomUUID: () => 'fixture-id' },
    Quality, RateQuality, TimingEngine, HistoryMode, FilterMode, InputChannel, selectChannel, channelLevels, timingStrip, drawVintageMeter, vintageSweep, StableHistory, drawStableHistory, amplitudeFromLift, Worker: FakeWorker, MicCapture: FakeMic,
    readAudio: file => file.read,
    localStorage: { getItem: () => null, setItem() {} }, navigator: {},
    document: { getElementById: element, createElement: () => makeElement(), querySelectorAll: () => [] },
    window: { devicePixelRatio: 1, addEventListener() {} }, requestAnimationFrame() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(appCode.replace(/^import[^\n]*\n/gm, ''), sandbox, { filename: 'app.mjs' });
  const fire = (id, type = 'click') => {
    for (const result of element(id).fire(type)) {
      if (result?.catch) result.catch(error => errors.push(error));
    }
  };
  const chooseFile = (name, read = Promise.resolve({ samples: watchAudio.slice(), sampleRate: NATIVE_RATE, sourceRateKnown: true })) => {
    element('audio-file').files = [{ name, read }]; fire('audio-file', 'change');
  };
  return { element, worker, microphones, errors, fire, chooseFile, advance(ms) {now+=ms;intervals.forEach(callback=>callback());} };
}

async function loadRecording(harness) {
  harness.chooseFile('watch.wav'); await settle();
  const result = harness.worker.analyze(); await settle();
  assert.equal(result.quality, Quality.Stable);
  return result;
}

test('Clear cancels a pending demo instead of restoring its source later', async () => {
  const h = makeHarness();
  h.fire('demo'); await settle(); const demo = h.worker.next(Job.Demo);
  assert.ok(demo);
  h.fire('clear'); await settle();
  h.worker.demo(demo); await settle();
  assert.equal(h.element('source-tag').textContent, 'NO SOURCE');
  assert.equal(h.element('metric-rate').textContent, EMPTY);
  assert.equal(h.worker.next(Job.Analyze), undefined);
  assert.deepEqual(h.errors, []);
});

test('a late demo cannot disconnect a newer microphone choice', async () => {
  const h = makeHarness();
  h.fire('demo'); await settle(); const demo = h.worker.next(Job.Demo);
  h.fire('connect'); await settle();
  assert.equal(h.element('source-tag').textContent, 'LIVE MICROPHONE');
  h.worker.demo(demo); await settle();
  assert.equal(h.element('source-tag').textContent, 'LIVE MICROPHONE');
  assert.equal(h.microphones[0].stopped, false);
  assert.equal(h.worker.next(Job.Analyze), undefined);
  assert.deepEqual(h.errors, []);
});

test('the latest file choice wins when decoding completes out of order', async () => {
  const h = makeHarness();
  const old = deferred();
  h.chooseFile('old.wav', old.promise);
  await settle();
  h.chooseFile('new.wav'); await settle();
  h.worker.analyze(); await settle();
  old.resolve({ samples: watchAudio.slice(), sampleRate: NATIVE_RATE, sourceRateKnown: true });
  await settle();
  assert.equal(h.element('source-state').textContent, 'new.wav');
  assert.equal(h.worker.next(Job.Analyze), undefined);
  assert.deepEqual(h.errors, []);
});

test('a settings edit queues replacement analysis after an obsolete job', async () => {
  const h = makeHarness();
  h.chooseFile('watch.wav'); await settle();
  const obsolete = h.worker.next(Job.Analyze);
  h.element('calibration').value = '100'; h.fire('calibration', 'change');
  h.worker.analyze(obsolete); await settle();
  const replacement = h.worker.next(Job.Analyze);
  assert.ok(replacement, 'The latest options need a replacement analysis');
  assert.equal(replacement.options.calibrationPpm, 100);
  assert.equal(h.element('metric-rate').textContent, EMPTY);
  const result = h.worker.analyze(replacement); await settle();
  assert.equal(h.element('metric-rate').textContent, `+${result.rate.toFixed(1)}`);
  assert.deepEqual(h.errors, []);
});

test('manual amplitude requires marker coordinates inside the displayed waveform', async () => {
  const h = makeHarness();
  await loadRecording(h);
  h.element('angle-verified').checked = true;
  h.element('pulses-verified').checked = true; h.fire('pulses-verified', 'input');
  assert.ok(Number(h.element('metric-amp').textContent) > 270, 'Visible ten-ms pulse selection can be estimated');
  for (const side of ['tick', 'tock']) {
    h.element(`${side}-unlock`).value = '1000'; h.element(`${side}-drop`).value = '1010';
  }
  h.fire('tick-unlock', 'input');
  assert.equal(h.element('metric-amp').textContent, EMPTY);
  assert.match(h.element('amplitude-feedback').textContent, /valid|bounds|range|waveform/i);
  assert.deepEqual(h.errors, []);
});

test('candidate clicks explain a failed timing lock without claiming silence', async () => {
  const h=makeHarness();
  h.chooseFile('headset.wav');await settle();
  h.worker.answer(h.worker.next(Job.Analyze),{result:{duration:22,quality:Quality.Weak,
    events:Array.from({length:128},(_,index)=>({time:index/6,strength:0.1})),
    coverage:0.93,jitterMs:12.25,snrDb:30,period:null,rate:null,bph:null,beatError:null,
    reason:'No repeatable watch rhythm. Improve microphone contact or reduce noise.'}});
  await settle();
  assert.match(h.element('quality').textContent,/clicks detected/i);
  assert.match(h.element('feedback').textContent,/12.25 ms/);
  assert.doesNotMatch(h.element('feedback').textContent,/improve microphone contact/i);
  assert.equal(h.element('metric-rate').textContent,EMPTY);
  assert.equal(h.element('save-baseline').disabled,true);
});

test('a rejected noisy fit cannot display its candidate as a measured rate', async () => {
  const h=makeHarness();
  h.chooseFile('scattered.wav');await settle();
  h.worker.answer(h.worker.next(Job.Analyze),{result:{duration:36,quality:Quality.Noisy,
    events:Array.from({length:100},(_,index)=>({time:index/6,strength:0.1})),
    coverage:0.8,jitterMs:3,snrDb:20,period:0.16,rate:3600,bph:22500,beatError:2,
    reason:'Timing is scattered.'}});
  await settle();
  assert.equal(h.element('metric-rate').textContent,EMPTY);
  assert.equal(h.element('metric-bph').textContent,EMPTY);
  assert.equal(h.element('metric-beat').textContent,EMPTY);
  assert.equal(h.element('save-baseline').disabled,true);
});

test('a repeatable waveform rate does not unlock beat error or amplitude', async () => {
  const h=makeHarness();
  h.chooseFile('changing-pulses.wav');await settle();
  h.worker.answer(h.worker.next(Job.Analyze),{result:{duration:60,quality:Quality.Weak,
    events:[],coverage:0.6,jitterMs:6,rate:null,bph:null,beatError:null,
    average:{quality:RateQuality.Stable,rate:24,bph:21606,period:1/6,spread:4,
      reason:'Average rate from waveform correlation.'}}});
  await settle();
  assert.equal(h.element('metric-rate').textContent,'+24.0');
  assert.match(h.element('note-rate').textContent,/spread 4/);
  assert.match(h.element('quality').textContent,/pulse detail unclear/);
  assert.equal(h.element('metric-beat').textContent,EMPTY);
  assert.equal(h.element('metric-amp').textContent,EMPTY);
  assert.equal(h.element('save-baseline').disabled,false);
  assert.match(h.element('history-summary').textContent,/1 stable readings/);
});

test('disagreeing waveform windows explain why rate remains blank', async () => {
  const h=makeHarness();
  h.chooseFile('unsteady.wav');await settle();
  h.worker.answer(h.worker.next(Job.Analyze),{result:{duration:60,quality:Quality.Weak,
    events:[],rate:null,bph:null,beatError:null,
    average:{quality:RateQuality.Unsteady,rate:null,spread:529,
      reason:'Waveform estimates disagree by about 529 s/day across separate halves.'}}});
  await settle();
  assert.equal(h.element('metric-rate').textContent,EMPTY);
  assert.match(h.element('quality').textContent,/rate not steady/);
  assert.match(h.element('feedback').textContent,/529 s\/day/);
  assert.equal(h.element('save-baseline').disabled,true);
  assert.equal(h.element('history-summary').textContent,'Waiting for stable readings');
});

test('tg supplies rate and beat error while amplitude waits for lift-angle confirmation', async () => {
  const h=makeHarness();
  h.chooseFile('tg-watch.wav');await settle();
  const result=tgAnalyzer.analyze(watchAudio,NATIVE_RATE,{bph:21600,liftAngle:53});
  h.worker.answer(h.worker.next(Job.Analyze),{result});await settle();
  assert.equal(h.element('metric-rate').textContent,'+24.0');
  assert.match(h.element('quality').textContent,/tg.*Repeatable/);
  assert.ok(Number(h.element('metric-beat').textContent)>1);
  assert.equal(h.element('metric-amp').textContent,EMPTY);
  assert.match(h.element('note-amp').textContent,/Confirm lift angle/);
  h.element('angle-verified').checked=true;h.fire('angle-verified','input');
  assert.ok(Number(h.element('metric-amp').textContent)>250);
  assert.match(h.element('note-amp').textContent,/tg pulse/);
  assert.equal(h.element('save-baseline').disabled,false);
});

test('demo lift-angle confirmation cannot carry into a real microphone take',async()=>{
  const h=makeHarness();
  h.fire('demo');await settle();h.worker.demo();await settle();h.worker.analyze();await settle();
  h.element('angle-verified').checked=true;
  h.fire('connect');await settle();
  assert.equal(h.element('angle-verified').checked,false);
  assert.equal(h.element('metric-amp').textContent,EMPTY);
});


test('default capture selects mic Input 1 at 48 kHz and tg filters',async()=>{
  const h=makeHarness();
  h.fire('connect');await settle();
  assert.equal(h.microphones[0].selection.channel,InputChannel.First);
  assert.equal(h.microphones[0].selection.rate,'48000');
  assert.equal(h.element('filter-mode').value,FilterMode.Tg);
  assert.equal(h.element('low-filter').disabled,true);
  assert.equal(h.element('high-filter').disabled,true);
  h.element('input-channel').value=InputChannel.Second;
  h.fire('input-channel','change');await settle();
  assert.equal(h.microphones[0].stopped,true);
  assert.equal(h.microphones[1].selection.channel,InputChannel.Second);
  assert.deepEqual(h.errors,[]);
});

test('filter changes discard a pending result from the prior filter mode',async()=>{
  const h=makeHarness();
  h.chooseFile('watch.wav');await settle();
  const old=h.worker.next(Job.Analyze);
  h.element('filter-mode').value=FilterMode.Custom;
  h.fire('filter-mode','change');
  h.worker.analyze(old);await settle();
  const fresh=h.worker.next(Job.Analyze);
  assert.ok(fresh);
  assert.equal(fresh.options.filterMode,FilterMode.Custom);
  assert.equal(h.element('metric-rate').textContent,EMPTY);
  assert.equal(h.element('low-filter').disabled,false);
  h.worker.analyze(fresh);await settle();
  assert.deepEqual(h.errors,[]);
});


test('changing a recorded stereo channel reanalyzes preserved audio; Clear forgets it',async()=>{
  const h=makeHarness();
  const first=Float32Array.from([0.5,0.25]);
  const second=Float32Array.from([-0.5,-0.25]);
  h.chooseFile('stereo.wav',Promise.resolve({samples:first,audioChannels:[first,second],sampleRate:NATIVE_RATE,sourceRateKnown:true}));
  await settle();h.worker.analyze();await settle();
  h.element('input-channel').value=InputChannel.Second;h.fire('input-channel','change');await settle();
  const selected=h.worker.next(Job.Analyze);
  assert.deepEqual([...selected.samples],[...second]);
  h.worker.analyze(selected);await settle();
  h.fire('clear');await settle();
  h.element('input-channel').value=InputChannel.First;h.fire('input-channel','change');await settle();
  assert.equal(h.element('source-tag').textContent,'NO SOURCE');
  assert.equal(h.worker.next(Job.Analyze),undefined);
  assert.deepEqual(h.errors,[]);
});


async function liveReading(h) {
  h.fire('connect');await settle();
  h.advance(5000);h.microphones[0].push(watchAudio,NATIVE_RATE,0);await settle();
  const reading=tgAnalyzer.analyze(watchAudio,NATIVE_RATE,{bph:21600,liftAngle:53});
  h.worker.answer(h.worker.next(Job.Analyze),{result:reading});await settle();
  return reading;
}

function lostReading(reading) {
  return {...reading,quality:Quality.Weak,rate:null,bph:null,beatError:null,
    engineAmplitude:null,fold:undefined,events:[],reason:'Timing lock lost.'};
}

test('lost lock dims the last valid metrics without enabling baseline or guidance',async()=>{
  const h=makeHarness();
  const reading=await liveReading(h);
  h.element('angle-verified').checked=true;h.fire('angle-verified','input');
  const metrics=['bph','rate','beat','amp'];
  const previous=metrics.map(metric=>h.element(`metric-${metric}`).textContent);
  assert.ok(previous.every(value=>value!==EMPTY));
  assert.match(h.element('history-summary').textContent,/1 stable readings/);
  assert.equal(h.element('save-baseline').disabled,false);
  h.advance(3000);
  h.microphones[0].push(new Float32Array(NATIVE_RATE),NATIVE_RATE,watchAudio.length);await settle();
  h.worker.answer(h.worker.next(Job.Analyze),{result:lostReading(reading)});await settle();
  for(const [index,metric] of metrics.entries()) {
    assert.equal(h.element(`metric-${metric}`).textContent,previous[index]);
    assert.equal(h.element(`metric-${metric}`).dataset.stale,'true');
    assert.equal(h.element(`note-${metric}`).textContent,'Stale · 3s ago');
  }
  assert.equal(h.element('save-baseline').disabled,true);
  assert.match(h.element('adjustment').textContent,/stable baseline first/);
  assert.match(h.element('history-summary').textContent,/1 stable readings/);
  h.advance(7000);
  assert.equal(h.element('note-rate').textContent,'Stale · 10s ago');
  h.microphones[0].push(new Float32Array(NATIVE_RATE),NATIVE_RATE,watchAudio.length+NATIVE_RATE);await settle();
  h.worker.answer(h.worker.next(Job.Analyze),{result:{...reading,rate:42}});await settle();
  assert.equal(h.element('metric-rate').textContent,'+42.0');
  assert.equal(h.element('metric-rate').dataset.stale,'false');
  assert.doesNotMatch(h.element('note-rate').textContent,/Stale/);
  assert.equal(h.element('save-baseline').disabled,false);
  assert.deepEqual(h.errors,[]);
});

test('capture gaps retain stale values; settings, sources and Clear forget them',async()=>{
  const h=makeHarness();
  await liveReading(h);
  const rate=h.element('metric-rate').textContent;
  h.advance(3000);
  h.microphones[0].push(new Float32Array(NATIVE_RATE),NATIVE_RATE,watchAudio.length+100);await settle();
  assert.equal(h.element('metric-rate').textContent,rate);
  assert.equal(h.element('metric-rate').dataset.stale,'true');
  assert.equal(h.element('save-baseline').disabled,true);
  h.element('filter-mode').value=FilterMode.Custom;h.fire('filter-mode','change');
  assert.equal(h.element('metric-rate').textContent,EMPTY);
  h.fire('clear');await settle();
  assert.equal(h.element('metric-rate').textContent,EMPTY);
  assert.equal(h.element('metric-rate').dataset.stale,'false');
  const fresh=makeHarness();await liveReading(fresh);
  fresh.chooseFile('other-watch.wav');await settle();
  assert.equal(fresh.element('metric-rate').textContent,EMPTY);
  assert.deepEqual(h.errors,[]);assert.deepEqual(fresh.errors,[]);
});
