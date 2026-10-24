import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAnalyzer, TimingEngine, HistoryMode, FilterMode } from './dist/watch-engine.mjs';
import { makeDemo, Quality } from './dist/dsp.mjs';
import { resampleAudio } from './dist/resample.mjs';

const bytes=fs.readFileSync(new URL('./dist/vendor/tg/tg-core.wasm',import.meta.url));
const analyzer=await createAnalyzer(bytes);
const SAMPLE_RATE=48000;
const OPTIONS={bph:21600,liftAngle:53,lowHz:1200,highHz:10000};
const near=(value,expected,tolerance)=>assert.ok(Number.isFinite(value) && Math.abs(value-expected)<tolerance,`${value} should be near ${expected}`);

for(const rate of [-900,0,24,1800]) {
  test(`the actual tg WASM measures ${rate} s/day, beat error and lift pulses`,()=>{
    const audio=makeDemo({seconds:36,sampleRate:SAMPLE_RATE,rate,beatError:1.2,liftMs:10});
    const result=analyzer.analyze(audio,SAMPLE_RATE,OPTIONS);
    assert.equal(result.engine,TimingEngine.Tg);
    assert.equal(result.quality,Quality.Stable);
    near(result.rate,rate,1);
    near(result.beatError,1.2,0.1);
    near(result.period,(1/6)/(1+rate/86400),0.00001);
    assert.ok(result.engineAmplitude>250 && result.engineAmplitude<310);
    assert.ok(result.fold.tick.length===700 && result.fold.tock.length===700);
    assert.ok(result.events.every(event=>event.time>=32 && event.time<=36));
  });
}

test('native 192 kHz audio gets anti-aliased timing without changing the timebase',()=>{
  const audio=makeDemo({seconds:20,sampleRate:192000,rate:-900,liftMs:10});
  const result=analyzer.analyze(audio,192000,OPTIONS);
  assert.equal(result.engineRate,48000);
  near(result.duration,20,0.00001);
  near(result.rate,-900,1);
  near(result.period,(1/6)/(1-900/86400),0.00001);
});

test('the downsampler rejects ultrasonic aliasing',()=>{
  const rate=192000;
  const tone=frequency=>Float32Array.from({length:rate},(_,index)=>Math.sin(2*Math.PI*frequency*index/rate));
  const rms=values=>Math.sqrt(values.subarray(1000,values.length-1000).reduce((sum,value)=>sum+value*value,0)/(values.length-2000));
  const audible=resampleAudio(tone(8000),rate);
  const ultrasound=resampleAudio(tone(40000),rate);
  assert.equal(audible.sampleRate,48000);
  assert.ok(rms(audible.samples)>0.65);
  assert.ok(rms(ultrasound.samples)<0.001);
});

test('clock correction has the same sign as the reference frequency formula',()=>{
  const audio=makeDemo({seconds:20,sampleRate:SAMPLE_RATE,rate:0,liftMs:10});
  const raw=analyzer.analyze(audio,SAMPLE_RATE,OPTIONS);
  const corrected=analyzer.analyze(audio,SAMPLE_RATE,{...OPTIONS,calibrationPpm:100});
  near(corrected.rate-raw.rate,8.64,0.02);
  near(corrected.period/raw.period,1/1.0001,0.000001);
});

test('noise, transients and a stopped watch cannot retain a tg reading',()=>{
  const noise=makeDemo({seconds:40,sampleRate:SAMPLE_RATE,noiseOnly:true});
  const transients=noise.slice();
  let seed=7009;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let time=0.1;time<40;time+=0.05+random()*0.18) {
    const start=Math.floor(time*SAMPLE_RATE);
    for(let i=0;i<64 && start+i<transients.length;i++) transients[start+i]+=Math.sin(i*0.8)*Math.exp(-i/16)*0.3;
  }
  const stopped=new Float32Array(60*SAMPLE_RATE);
  stopped.set(makeDemo({seconds:20,sampleRate:SAMPLE_RATE}));
  for(const audio of [noise,transients,stopped,new Float32Array(20*SAMPLE_RATE)]) {
    const result=analyzer.analyze(audio,SAMPLE_RATE,OPTIONS);
    assert.equal(result.rate,null);
    assert.equal(result.beatError,null);
    assert.equal(result.engineAmplitude,null);
    assert.equal(result.fold,undefined);
  }
});

test('clipping prevents saving even when tg can fit the underlying cadence',()=>{
  const audio=makeDemo({seconds:36,sampleRate:SAMPLE_RATE,gain:12,liftMs:10});
  const result=analyzer.analyze(audio,SAMPLE_RATE,OPTIONS);
  assert.equal(result.quality,Quality.Noisy);
});

test('a changed rate can have a current lock without a repeatable baseline',()=>{
  const audio=makeDemo({seconds:32,sampleRate:SAMPLE_RATE,rate:-900,liftMs:10});
  audio.set(makeDemo({seconds:16,sampleRate:SAMPLE_RATE,rate:120,liftMs:10}),16*SAMPLE_RATE);
  const result=analyzer.analyze(audio,SAMPLE_RATE,OPTIONS);
  assert.equal(result.quality,Quality.Usable);
  near(result.rate,120,1);
  assert.ok(result.rateSpread>1000);
});

test('invalid clock correction cannot create infinite periods or a saveable baseline',()=>{
  const audio=makeDemo({seconds:3,sampleRate:SAMPLE_RATE});
  for(const calibrationPpm of [-1000000,-2000000,5001,NaN,Infinity]) {
    assert.throws(()=>analyzer.analyze(audio,SAMPLE_RATE,{...OPTIONS,calibrationPpm}),RangeError);
  }
});

test('recording history contains real tg positions across the whole take',()=>{
  const audio=makeDemo({seconds:36,sampleRate:SAMPLE_RATE,rate:24,liftMs:10});
  const result=analyzer.analyze(audio,SAMPLE_RATE,{...OPTIONS,historyMode:HistoryMode.Complete});
  assert.equal(result.quality,Quality.Stable);
  assert.ok(result.events.length>190);
  assert.ok(result.events[0].time<4);
  assert.ok(result.events.at(-1).time>35);
});


test('custom filtering is optional and preserves rate on the same signal',()=>{
  const audio=makeDemo({seconds:36,sampleRate:SAMPLE_RATE,rate:24,beatError:1.2,liftMs:10});
  for(const filterMode of [FilterMode.Tg,FilterMode.Custom]) {
    const result=analyzer.analyze(audio,SAMPLE_RATE,{...OPTIONS,filterMode});
    assert.equal(result.quality,Quality.Stable);
    near(result.rate,24,1);
    near(result.beatError,1.2,0.1);
  }
});
