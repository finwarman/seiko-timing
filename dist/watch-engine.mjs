import createTg from './vendor/tg/tg-core.js';
import { Bandpass } from './vendor/js-timegrapher/filters.mjs';
import { resampleAudio } from './resample.mjs';
import { Quality } from './dsp.mjs';

export const TimingEngine = Object.freeze({ Tg: 'tg-wasm' });
export const FilterMode = Object.freeze({ Tg: 'tg-default', Custom: 'custom-bandpass' });
export const HistoryMode = Object.freeze({ Latest: 'latest', Complete: 'complete' });
const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;
const WINDOW_SECONDS = 16;
const STABLE_SPREAD = 20;
const CLIP_LIMIT = 0.001;
const CHUNK_SAMPLES = 8192;
const MAX_EVENTS = 100;
const MAX_CLOCK_PPM = 5000;
const HISTORY_INTERVAL = 3;
const FIRST_HISTORY_SECONDS = 2;
const ResultField = Object.freeze({ Rate:0, Amplitude:1, BeatError:2, Bph:3, Quality:4, Valid:5 });
const WaveField = Object.freeze({ Points:0, Before:1, After:2, Period:3, TickLift:4, TockLift:5, Valid:6 });

function audioLevel(samples) {
  let peak=0,energy=0,clipped=0;
  for(const value of samples) {
    const absolute=Math.abs(value);
    peak=Math.max(peak,absolute);energy+=value*value;
    if(absolute>=0.995) clipped++;
  }
  return {peak,rms:Math.sqrt(energy/Math.max(1,samples.length)),clippedRatio:clipped/Math.max(1,samples.length)};
}

function filterAudio(samples,sampleRate,options) {
  const filtered=Float32Array.from(samples,value=>Number.isFinite(value)?value:0);
  if(options.filterMode===FilterMode.Custom) {
    const low=Math.min(Math.max(100,Number(options.lowHz)||1200),sampleRate*0.35);
    const high=Math.min(Math.max(low+100,Number(options.highHz)||10000),sampleRate*0.45);
    new Bandpass(sampleRate,low,high).processInPlace(filtered);
  }
  return resampleAudio(filtered,sampleRate);
}

class WatchAnalyzer {
  #module;

  constructor(module) {this.#module=module;}

  #readWindow(samples,sampleRate,options,historyMode=HistoryMode.Latest) {
    const module=this.#module;
    const handle=module._tgw_init(sampleRate,options.bph,options.liftAngle);
    if(!handle) throw new Error('The tg engine could not initialize. Check BPH and lift angle.');
    const allocations=[];
    const allocate=bytes=>{const pointer=module._malloc(bytes);if(!pointer)throw new Error('The tg engine ran out of memory.');allocations.push(pointer);return pointer;};
    try {
      const input=allocate(CHUNK_SAMPLES*4);
      const output=allocate(module._tgw_result_fields()*8);
      const times=allocate(MAX_EVENTS*8),sides=allocate(MAX_EVENTS);
      const events=[];
      const readEvents=()=>{
        const count=module._tgw_events(handle,times,sides,MAX_EVENTS);
        for(let index=0;index<count;index++) {
          const point={time:module.HEAPF64[times/8+index],side:module.HEAPU8[sides+index],strength:1};
          const previous=events.findIndex(event=>Math.abs(event.time-point.time)<HOUR_SECONDS/options.bph*0.3);
          if(previous<0) events.push(point);
          else events[previous]=point;
        }
      };
      let nextHistory=FIRST_HISTORY_SECONDS*sampleRate;
      for(let start=0;start<samples.length;start+=CHUNK_SAMPLES) {
        const part=samples.subarray(start,start+CHUNK_SAMPLES);
        module.HEAPF32.set(part,input/4);
        module._tgw_push(handle,input,part.length);
        if(historyMode===HistoryMode.Complete && start+part.length>=nextHistory) {
          module._tgw_result(handle,output);
          if(module.HEAPF64[output/8+ResultField.Valid]) readEvents();
          nextHistory=start+part.length+HISTORY_INTERVAL*sampleRate;
        }
      }
      module._tgw_result(handle,output);
      const fields=Array.from(module.HEAPF64.subarray(output/8,output/8+module._tgw_result_fields()));
      if(!fields[ResultField.Valid]) return {valid:false};
      readEvents();
      events.sort((a,b)=>a.time-b.time);
      const points=module._tgw_waveform_points();
      const tick=allocate(points*4),tock=allocate(points*4),info=allocate(module._tgw_waveform_fields()*8);
      module._tgw_waveform(handle,tick,tock,info);
      const wave=Array.from(module.HEAPF64.subarray(info/8,info/8+module._tgw_waveform_fields()));
      return {valid:true,rate:fields[ResultField.Rate],amplitude:fields[ResultField.Amplitude],
        beatError:fields[ResultField.BeatError],nominalBph:fields[ResultField.Bph],
        signalQuality:fields[ResultField.Quality],events,wave,
        tick:Array.from(module.HEAPF32.subarray(tick/4,tick/4+points)),
        tock:Array.from(module.HEAPF32.subarray(tock/4,tock/4+points))};
    } finally {
      for(const pointer of allocations) module._free(pointer);
      module._tgw_destroy(handle);
    }
  }

  analyze(samples,sampleRate,options={}) {
    if(!(samples instanceof Float32Array)||!Number.isFinite(sampleRate)||sampleRate<8000) throw new TypeError('Provide native-rate Float32Array audio.');
    const config={bph:options.bph==null?21600:Number(options.bph),liftAngle:options.liftAngle==null?53:Number(options.liftAngle)};
    const calibration=options.calibrationPpm==null?0:Number(options.calibrationPpm);
    if(!Number.isFinite(calibration)||Math.abs(calibration)>MAX_CLOCK_PPM) throw new RangeError('Audio clock correction must be between -5000 and 5000 ppm.');
    if(!Number.isFinite(config.liftAngle)||config.liftAngle<10||config.liftAngle>90) throw new RangeError('The tg lift angle must be between 10 and 90 degrees.');
    const correction=1+calibration/1e6;
    const duration=samples.length/sampleRate;
    const reading={...audioLevel(samples),duration,quality:duration<2?Quality.Waiting:Quality.Weak,
      engine:TimingEngine.Tg,engineRate:0,engineQuality:0,engineAmplitude:null,
      engineLiftAngle:config.liftAngle,rateSpread:null,windowRates:[],
      rate:null,bph:null,period:null,beatError:null,beatErrorReliable:false,beatErrorProvisional:true,
      events:[],coverage:0,jitterMs:0,snrDb:0,oneSided:false,
      reason:'tg is collecting audio. Keep the watch and microphone still.'};
    if(duration<2) return reading;
    const audio=filterAudio(samples,sampleRate,options);
    reading.engineRate=audio.sampleRate;
    const size=WINDOW_SECONDS*audio.sampleRate;
    const start=Math.max(0,audio.samples.length-size);
    const complete=options.historyMode===HistoryMode.Complete;
    const current=this.#readWindow(complete?audio.samples:audio.samples.subarray(start),audio.sampleRate,config,complete?HistoryMode.Complete:HistoryMode.Latest);
    if(!current.valid) {
      reading.reason='The tg engine has not locked onto a consistent tick/tock waveform. Try a quieter position or another microphone placement, then leave it still for 16 seconds.';
      return reading;
    }
    const correctedRate=rate=>DAY_SECONDS*((1+rate/DAY_SECONDS)*correction-1);
    const rate=correctedRate(current.rate);
    reading.rate=rate;
    reading.bph=current.nominalBph*(1+rate/DAY_SECONDS);
    reading.period=HOUR_SECONDS/reading.bph;
    reading.beatError=current.beatError/correction;
    reading.engineQuality=current.signalQuality;
    reading.engineAmplitude=current.amplitude>0?current.amplitude:null;
    reading.events=current.events.map(event=>({...event,time:(event.time+(complete?0:start/audio.sampleRate))/correction}));
    reading.quality=Quality.Usable;
    reading.reason='tg has a timing lock. Rate and beat error come from its averaged escapement waveform. Amplitude also needs a confirmed lift angle.';
    reading.windowRates=[rate];
    if(start>=size) {
      const previous=this.#readWindow(audio.samples.subarray(start-size,start),audio.sampleRate,config);
      if(previous.valid) {
        reading.windowRates.unshift(correctedRate(previous.rate));
        reading.rateSpread=Math.abs(reading.windowRates[0]-rate);
        if(reading.rateSpread<=STABLE_SPREAD && Math.min(previous.signalQuality,current.signalQuality)>=0.75) reading.quality=Quality.Stable;
      }
      reading.reason=reading.quality===Quality.Stable
        ?`tg found repeatable timing in separate windows. Rate spread ${reading.rateSpread.toFixed(1)} s/day. Confirm with a fresh take before adjusting.`
        :`tg has a current timing lock, but separate windows ${reading.rateSpread===null?'did not both lock':`differ by ${reading.rateSpread.toFixed(1)} s/day`}. Save a baseline after the rate settles.`;
    }
    if(current.wave[WaveField.Valid]) {
      const maximum=Math.max(...current.tick,...current.tock,1e-9);
      reading.fold={tick:current.tick.map(value=>value/maximum),tock:current.tock.map(value=>value/maximum),
        startMs:-current.wave[WaveField.Before]/correction,
        stepMs:(current.wave[WaveField.Before]+current.wave[WaveField.After])/current.wave[WaveField.Points]/correction,
        count:current.events.length,noiseFloor:0};
      reading.enginePulses={tickMs:current.wave[WaveField.TickLift]/correction,tockMs:current.wave[WaveField.TockLift]/correction};
      // This tg build returns a full oscillation despite its header saying one beat.
      reading.period=current.wave[WaveField.Period]/(2*correction);
    }
    if(reading.clippedRatio>CLIP_LIMIT) {
      reading.quality=Quality.Noisy;
      reading.reason='Input is clipping. Reduce gain before using the timing result.';
    }
    return reading;
  }
}

/** Optional WASM bytes allow the identical engine to run in offline Node checks. */
export async function createAnalyzer(wasmBytes) {
  if(!wasmBytes) return new WatchAnalyzer(await createTg());
  const compiled=await WebAssembly.compile(wasmBytes);
  const module=await createTg({instantiateWasm(imports,receive) {
    const instance=new WebAssembly.Instance(compiled,imports);
    receive(instance);
    return instance.exports;
  }});
  return new WatchAnalyzer(module);
}
