import {InputChannel,selectChannel,channelLevels} from './channels.mjs';
import {MicCapture,readAudio,encodeWav} from './capture.mjs';
import {Quality,amplitudeFromLift} from './dsp.mjs';
import {RateQuality} from './rate.mjs';
import {TimingEngine,HistoryMode,FilterMode} from './watch-engine.mjs';
import {timingStrip} from './timing-strip.mjs';
import {drawVintageMeter} from './vintage-meter.mjs';
import {vintageSweep} from './vintage-sweep.mjs';
import {StableHistory,drawStableHistory} from './stable-history.mjs';

const Source=Object.freeze({None:'none',Mic:'microphone',File:'recording',Demo:'demo'});
const Job=Object.freeze({Analyze:'analyze',Demo:'demo'});
const Preset=Object.freeze({Slow:'slow',Stable:'stable',Noise:'noise'});
const RateMethod=Object.freeze({Pulse:'pulse',Waveform:'waveform'});
const Metric=Object.freeze({Bph:'bph',Rate:'rate',Beat:'beat',Amp:'amp'});
const MetricHistory=Object.freeze({Clear:'clear',Keep:'keep'});
const EMPTY_METRIC='–';
const STALE_REFRESH_MS=1000;
const DIAL_FRAME_MS=50;
const SPECTRUM_FRAME_MS=100;
let lastDialFrame=0;
let spectrumPaint=null;
const lastMetrics=new Map();
const LOG_KEY='seiko-watch-bench-log-v1';
const HISTORY_KEY='seiko-stable-history-v1';
const WINDOW_SECONDS=60;
const RETAIN_SECONDS=65;
const LIVE_ANALYSIS_SECONDS=32;
const MIN_BASELINE_SECONDS=32;
const LARGE_RATE=300;
const CLIP_LIMIT=0.001;
const $=id=>document.getElementById(id);
const worker=new Worker('analysis-worker.mjs',{type:'module'});
const spectrumWorker=new Worker('spectrum-worker.mjs',{type:'module'});
const jobs=new Map();
const spectralSurface=document.createElement('canvas');
let spectrumGeneration=0;
let spectrumColumns=[];
let spectrumMaxHz=16000;
let jobId=0;
let generation=0;
let sourceRequest=0;
let source=Source.None;
let sourceName='';
let sampleRate=0;
let sourceRate=null;
let fileChannels=[];
let chunks=[];
let sampleCount=0;
let totalCount=0;
let measurement=null;
let measurementAt=0;
let amplitude=null;
let engine=null;
let running=false;
let busy=false;
let analysisQueued=false;
let step=0;
let lastAnalysis=0;
let lastFrame=null;
let demoSeed=7009;
let activeConnect=0;
let log=[];
let traceHistory=[];
let traceOrigin=null;
let traceEnd=0;
let traceGeneration=0;
let vintageGeneration=0;
const vintageMarks=new Map();
let stableHistory=new StableHistory();
const demoHistory=new StableHistory();
let historyKey='';
let historyView=[];
let historySaved=true;
try {const saved=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');if(Array.isArray(saved))stableHistory=new StableHistory(saved);} catch { /* History is optional when storage is unavailable. */ }
try { const saved=JSON.parse(localStorage.getItem(LOG_KEY)||'[]'); if(Array.isArray(saved)) log=saved.slice(0,50); } catch { /* Storage is optional in private browsing. */ }

worker.onmessage=event=>{
  const job=jobs.get(event.data.id);
  if(!job) return;
  jobs.delete(event.data.id);
  if(event.data.error) job.reject(new Error(event.data.error));
  else job.resolve(event.data);
};
worker.onerror=event=>{
  for(const job of jobs.values()) job.reject(new Error(event.message||'The audio analyser could not start.'));
  jobs.clear();
  showError('The audio analyser could not start. Reload this page from its localhost address.');
};
spectrumWorker.onmessage=event=>{
  const data=event.data;
  if(data.generation!==spectrumGeneration)return;
  spectrumMaxHz=data.maxHz;
  data.columns.forEach((values,index)=>spectrumColumns.push({values,time:data.start+(index+0.5)*data.hopSeconds}));
  const cutoff=(spectrumColumns.at(-1)?.time||0)-10.1;
  spectrumColumns=spectrumColumns.filter(column=>column.time>=cutoff);
  if(spectrumPaint===null)spectrumPaint=setTimeout(()=>{spectrumPaint=null;drawSpectrogram();},SPECTRUM_FRAME_MS);
};

function runJob(type,data) {
  const id=++jobId;
  return new Promise((resolve,reject)=>{
    jobs.set(id,{resolve,reject});
    const message={id,type,...data};
    const transfers=data.samples ? [data.samples.buffer] : [];
    worker.postMessage(message,transfers);
  });
}

function showError(message='') { $('error').textContent=message; $('error').hidden=!message; }
function signed(value,digits=1) { return `${value>=0?'+':'−'}${Math.abs(value).toFixed(digits)}`; }
function rateText(value) { return Number.isFinite(value)?signed(value):'–'; }
function formatHz(value) { return value>=1000?`${Number((value/1000).toFixed(1))} kHz`:`${value} Hz`; }
function setStep(value) {
  step=Math.max(0,Math.min(3,value));
  document.querySelectorAll('[data-step]').forEach(button=>{
    if(Number(button.dataset.step)===step) button.setAttribute('aria-current','step');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-guide]').forEach(panel=>{panel.hidden=Number(panel.dataset.guide)!==step;});
  $('source-panel').hidden=step>0 && source!==Source.None;
  renderMetrics();
}

function readOptions() {
  return {filterMode:$('filter-mode').value,inputChannel:$('input-channel').value,bph:Number($('bph').value),lowHz:Number($('low-filter').value),highHz:Number($('high-filter').value),calibrationPpm:Number($('calibration').value)||0,liftAngle:Number($('lift-angle').value),historyMode:source===Source.Mic?HistoryMode.Latest:HistoryMode.Complete};
}

function resetData(history=MetricHistory.Clear) {
  if(history===MetricHistory.Clear) lastMetrics.clear();
  if(source===Source.Demo) $('angle-verified').checked=false;
  generation++;
  analysisQueued=false;
  fileChannels=[];chunks=[];sampleCount=0;totalCount=0;measurement=null;amplitude=null;lastFrame=null;lastAnalysis=0;
  traceHistory=[];traceOrigin=null;traceEnd=0;traceGeneration=generation;
  $('pulses-verified').checked=false;
  $('identified').checked=false;
  clearCanvas($('spectrogram'));
  spectrumColumns=[];spectrumGeneration++;
  spectrumWorker.postMessage({type:'reset',generation:spectrumGeneration,sampleRate:0});
  $('spectrum-empty').hidden=false;
  $('feedback').textContent='Collecting audio · keep the setup still';
  renderMetrics();drawTrace();drawPulses();
}

async function stopCapture() {
  activeConnect++;
  running=false;
  if(engine) { const old=engine;engine=null;await old.stop(); }
  $('capture-led').className='led';
  $('capture-label').textContent='Microphone off';
  $('stop').disabled=true;
  $('connect').textContent='Connect microphone';
  $('connect').disabled=false;
}

function renderChannels(levels) {
  const selected=$('input-channel').value;
  const channel=selected===InputChannel.Mix?'mix':selected===InputChannel.Second && levels.length>1?'Input 2':'Input 1';
  $('channel-levels').textContent=`${levels.map((level,index)=>`Input ${index+1}: ${level.toFixed(1)} dBFS`).join(' · ')} · using ${channel}${levels.length===1?' (mono)':''}`;
}

function appendSamples(samples,rate,frame,levels) {
  if(!running) return;
  if(lastFrame!==null && frame!==lastFrame) {
    resetData(MetricHistory.Keep);
    showError('A gap interrupted capture. This take restarted so the timing stays continuous.');
  }
  if(levels) renderChannels(levels);
  lastFrame=frame+samples.length;
  sampleRate=rate;
  chunks.push(samples);sampleCount+=samples.length;totalCount+=samples.length;
  const spectralCopy=samples.slice();
  spectrumWorker.postMessage({type:'append',generation:spectrumGeneration,sampleRate:rate,samples:spectralCopy},[spectralCopy.buffer]);
  while(chunks.length>1 && sampleCount-chunks[0].length>rate*RETAIN_SECONDS) sampleCount-=chunks.shift().length;
  const now=performance.now();
  if(now-lastAnalysis>2500) { lastAnalysis=now;void analyse(); }
  $('spectrum-empty').hidden=true;
  updateClock();
}

function collectSamples(seconds=WINDOW_SECONDS) {
  const size=Math.min(sampleCount,Math.floor(sampleRate*seconds));
  const output=new Float32Array(size);
  let skip=sampleCount-size;
  let at=0;
  for(const chunk of chunks) {
    if(skip>=chunk.length) {skip-=chunk.length;continue;}
    const part=chunk.subarray(skip);output.set(part,at);at+=part.length;skip=0;
  }
  return output;
}

async function analyse() {
  if(!sampleCount || !sampleRate) return;
  if(!$('calibration').checkValidity() || !$('lift-angle').checkValidity() || !$('lift-angle').value.trim()) {
    measurement=null;renderMetrics();drawTrace();showError('Enter a valid lift angle and clock correction before measuring.');return;
  }
  if(busy) {analysisQueued=true;return;}
  const token=generation;
  const captureEnd=totalCount/sampleRate;
  const capturedAt=performance.now();
  busy=true;
  try {
    const result=await runJob(Job.Analyze,{samples:collectSamples(source===Source.Mic?LIVE_ANALYSIS_SECONDS:WINDOW_SECONDS),sampleRate,options:readOptions()});
    if(token!==generation) return;
    measurement=result.result;measurementAt=capturedAt;
    recordTrace(measurement,captureEnd);
    recordHistory();
    renderMetrics();drawTrace();drawPulses();
  } catch(error) { if(token===generation) showError(error.message); }
  finally {busy=false;if(analysisQueued){analysisQueued=false;void analyse();}}
}

async function listDevices() {
  if(!navigator.mediaDevices?.enumerateDevices) return;
  const selected=$('device').value;
  const devices=await navigator.mediaDevices.enumerateDevices();
  $('device').replaceChildren(new Option('System default',''));
  devices.filter(device=>device.kind==='audioinput').forEach((device,index)=>$('device').add(new Option(device.label||`Microphone ${index+1}`,device.deviceId)));
  if([...$('device').options].some(option=>option.value===selected)) $('device').value=selected;
}

async function connectMic() {
  const request=++sourceRequest;
  await stopCapture();
  if(request!==sourceRequest) return;
  resetData();showError();
  source=Source.None;sourceName='';sampleRate=0;sourceRate=null;updateSource();
  const token=++activeConnect;
  $('connect').disabled=true;$('connect').textContent='Waiting for permission…';
  const candidate=new MicCapture(appendSamples,message=>{void stopCapture();showError(message);});
  try {
    const info=await candidate.start($('device').value,$('sample-rate').value,$('input-channel').value);
    if(token!==activeConnect || request!==sourceRequest) {await candidate.stop();return;}
    fileChannels=[];engine=candidate;running=true;source=Source.Mic;sourceName=info.label||'Microphone';
    sampleRate=info.processingRate;sourceRate=info.captureRate;
    engine.setBand(readOptions().lowHz,readOptions().highHz);
    $('capture-led').className='led active';$('capture-label').textContent='Microphone on';$('stop').disabled=false;
    $('connect').textContent='Reconnect microphone';$('connect').disabled=false;
    const state=info.settings;
    const onOff=value=>value===undefined?'not reported':value?'on':'off';
    $('capture-details').textContent=`${sourceName} · requested ${formatHz(info.requestedRate)} · capture ${sourceRate?formatHz(sourceRate):'not reported'} · processing ${formatHz(sampleRate)} · noise suppression ${onOff(state.noiseSuppression)} · auto gain ${onOff(state.autoGainControl)} · echo cancellation ${onOff(state.echoCancellation)}`;
    $('source-state').textContent=sourceName;
    if(state.noiseSuppression || state.autoGainControl || state.echoCancellation) showError('The input reports voice processing enabled. Disable noise suppression, auto gain or echo cancellation in your device settings if possible.');
    await listDevices();updateSource();setStep(1);
  } catch(error) {
    await candidate.stop();
    if(token!==activeConnect || request!==sourceRequest) return;
    const messages={NotAllowedError:'Microphone permission was denied. Allow this localhost page in the browser’s microphone settings, or open a recording instead.',NotFoundError:'No microphone was found. Connect a headset or USB microphone.',NotReadableError:'The microphone is busy or unavailable. Check other apps and the selected input.'};
    showError(messages[error.name]||error.message);
    $('connect').textContent='Connect microphone';$('connect').disabled=false;
  }
}

function updateSource() {
  const labels={[Source.None]:'NO SOURCE',[Source.Mic]:'LIVE MICROPHONE',[Source.File]:'RECORDING',[Source.Demo]:'DEMO SIGNAL'};
  $('source-tag').textContent=labels[source];$('source-tag').classList.toggle('demo',source===Source.Demo);
  $('demo-banner').hidden=source!==Source.Demo;$('demo-options').hidden=source!==Source.Demo;
  $('capture-rate').textContent=`Capture ${sourceRate?formatHz(sourceRate):'unknown'} / processing ${sampleRate?formatHz(sampleRate):'–'}`;
  $('spectrogram-source').textContent=source===Source.Mic?'Live · continuous analysis':source===Source.None?'No audio':'Recorded audio';
  $('download-audio').disabled=!sampleCount;
  drawHistory();
}

async function useRecording(samples,rate,kind,name,nativeRate,request,channels=[]) {
  if(request!==sourceRequest) return;
  await stopCapture();resetData();
  if(request!==sourceRequest) return;
  source=kind;sourceName=name;sampleRate=rate;sourceRate=nativeRate;fileChannels=channels;
  chunks=[samples];sampleCount=samples.length;totalCount=samples.length;
  renderChannels(channelLevels(channels.length?channels:[samples]));
  $('source-state').textContent=name;
  $('capture-details').textContent=`${name} · ${nativeRate?'native':'browser-decoded'} ${formatHz(rate)} · ${Math.round(samples.length/rate)} seconds · no microphone connected`;
  updateSource();setStep(2);updateClock();await analyse();await drawRecording();
}

async function loadDemo() {
  const request=++sourceRequest;
  await stopCapture();
  if(request!==sourceRequest) return;
  resetData();source=Source.None;sourceName='';sampleRate=0;sourceRate=null;updateSource();setStep(0);
  showError();$('demo').disabled=true;$('demo').textContent='Generating…';
  const preset=$('demo-preset').value;
  const options={seconds:60,sampleRate:96000,bph:Number($('bph').value),rate:preset===Preset.Stable?0:-900,beatError:1.2,liftMs:10,noise:preset===Preset.Noise?0.035:0.003,noiseOnly:preset===Preset.Noise,seed:++demoSeed};
  try {
    const result=await runJob(Job.Demo,{options});
    if(request!==sourceRequest) return;
    await useRecording(new Float32Array(result.samples),result.sampleRate,Source.Demo,preset===Preset.Noise?'Demo · poor pickup':preset===Preset.Stable?'Demo · stable watch':'Demo · reported loss',result.sampleRate,request);
  } catch(error) {if(request===sourceRequest)showError(error.message);}
  finally {if(request===sourceRequest){$('demo').disabled=false;$('demo').textContent='Try demo';}}
}

async function openFile(event) {
  const file=event.target.files[0];if(!file) return;
  const request=++sourceRequest;
  await stopCapture();
  if(request!==sourceRequest) return;
  resetData();source=Source.None;sourceName='';sampleRate=0;sourceRate=null;updateSource();
  showError();
  try {
    const audio=await readAudio(file,$('input-channel').value);
    if(request!==sourceRequest) return;
    await useRecording(audio.samples,audio.sampleRate,Source.File,file.name,audio.sourceRateKnown?audio.sampleRate:null,request,audio.audioChannels);
    if(!audio.sourceRateKnown) $('feedback').textContent+=' Browser decoding may resample this format. Native PCM WAV preserves its stated sample rate.';
  } catch(error) {if(request===sourceRequest)showError(`Could not open recording: ${error.message}`);}
  finally {event.target.value='';}
}

function updateClock() {
  const seconds=sampleRate?Math.floor(totalCount/sampleRate):0;
  $('elapsed').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}

function selectRate(value) {
  if(!value || value.clippedRatio>CLIP_LIMIT) return null;
  const pulse=[Quality.Usable,Quality.Stable].includes(value.quality) && Number.isFinite(value.rate);
  const average=value.average;
  const waveform=[RateQuality.Usable,RateQuality.Stable].includes(average?.quality) && Number.isFinite(average?.rate);
  if(pulse && (value.quality===Quality.Stable || average?.quality!==RateQuality.Stable)) return {...value,stable:value.quality===Quality.Stable,method:RateMethod.Pulse};
  if(waveform) return {...average,stable:average.quality===RateQuality.Stable,method:RateMethod.Waveform};
  return null;
}

function renderMetrics() {
  const value=measurement;
  const tg=value?.engine===TimingEngine.Tg;
  const timing=selectRate(value),hasRate=!!timing;
  const waveform=timing?.method===RateMethod.Waveform;
  const hasDetail=[Quality.Usable,Quality.Stable].includes(value?.quality);
  const hasCandidates=value?.events?.length>0;
  const unlocked=value?.quality===Quality.Weak && hasCandidates;
  const unsteady=!hasRate && value?.average?.quality===RateQuality.Unsteady;
  const clipped=value?.clippedRatio>CLIP_LIMIT;
  $('metric-bph').textContent=hasRate && timing.bph?Math.round(timing.bph).toLocaleString():'–';
  $('metric-rate').textContent=hasRate?rateText(timing.rate):'–';
  $('metric-rate').classList.toggle('warning',hasRate && Math.abs(timing.rate)>LARGE_RATE);
  $('metric-beat').textContent=hasDetail && Number.isFinite(value.beatError)?value.beatError.toFixed(2):'–';
  $('note-bph').textContent=waveform?'Full-cycle cadence × 2':value?.oneSided && hasRate?'Inferred · one audible side':`Expected ${Number($('bph').value).toLocaleString()}`;
  $('note-rate').textContent=waveform?`Waveform average · spread ${Math.ceil(timing.spread)} s/day`:hasRate?`${timing.rate>=0?'Gaining':'Losing'} · ${value.duration.toFixed(0)} s window`:'Waiting for timing lock';
  $('note-beat').textContent=hasDetail && Number.isFinite(value.beatError)?'Provisional acoustic estimate':'Needs clear pulse timing';
  $('quality').textContent=waveform?'Average rate found; pulse detail unclear':unsteady?'Repeating rhythm; rate not steady':unlocked?'Clicks detected; timing not locked':value?.quality===Quality.Stable?'Repeatable signal':value?.quality===Quality.Usable?'Rhythm detected':value?.quality===Quality.Noisy?(clipped?'Input clipping':'Timing not locked'):value?.quality===Quality.Weak?'Searching for repeating clicks':'Waiting for audio';
  $('quality-led').className=`led ${timing?.stable?'active':clipped?'bad':hasCandidates || waveform || unsteady?'warning':''}`;
  $('feedback').textContent=waveform || unsteady?value.average.reason:unlocked?`Clicks detected. Timing scatter is ${value.jitterMs.toFixed(2)} ms. The pulse detector has not locked. Waveform averaging checks rate separately; beat error needs clearer pulse timing.`:value?.reason || (source===Source.None?'Choose an input to begin':'Collecting audio · keep the setup still');
  $('level').textContent=value?.rms>0?`${(20*Math.log10(value.rms)).toFixed(1)} dBFS`:'– dBFS';
  $('snr').textContent=value?.snrDb?`Click contrast ${value.snrDb.toFixed(0)} dB`:'Click contrast –';
  $('event-count').textContent=`${value?.events?.length||0} ${hasRate?'matched':'candidate'} events${value?.coverage?` · ${(100*value.coverage).toFixed(0)}% grid coverage`:''}${value?.events?.length?` · timing scatter ${value.jitterMs.toFixed(2)} ms`:''}`;
  if(tg) {
    $('quality').textContent=clipped?'Input clipping':timing?.stable?'Repeatable timing':hasRate?'Timing lock':value.duration<2?'Collecting audio':'No timing lock';
    $('note-rate').textContent=hasRate?`${value.rateSpread===null?'Checking separate windows':`window spread ${value.rateSpread.toFixed(1)} s/day`}`:'Waiting for timing lock';
    $('note-beat').textContent=hasDetail && Number.isFinite(value.beatError)?'Acoustic estimate':'Needs timing lock';
    $('snr').textContent=`tg windows converged: ${Math.round(value.engineQuality*4)}/4`;
    $('event-count').textContent=`${value.events.length} tg beat positions · ${source===Source.Mic?'recent beats':'recording history'}`;
    $('capture-rate').textContent=`Capture ${sourceRate?formatHz(sourceRate):'unknown'} / audio ${formatHz(sampleRate)}${value.engineRate?` / tg ${formatHz(value.engineRate)}`:''}`;
  }
  if (tg && timing?.stable && !clipped) $('feedback').textContent='Check with a fresh take before adjusting.';
  const ready=!!timing?.stable && value.duration>=MIN_BASELINE_SECONDS;
  $('save-baseline').disabled=!ready;
  $('baseline-message').textContent=ready?'Ready to save · repeat a fresh take to confirm':'Saving needs 32 seconds and two repeatable windows.';
  $('download-audio').disabled=!sampleCount;
  calcAmplitude();
  for(const metric of [Metric.Bph,Metric.Rate,Metric.Beat]) retainMetric(metric);
  if(!ready) $('adjustment').textContent='Save a stable baseline first. Measure for 60 seconds.';
  else if(Math.abs(timing.rate)>LARGE_RATE) $('adjustment').textContent=`${rateText(timing.rate)} s/day is a large error. Check power and intermittent stopping before fine regulation. If it persists at a regulator limit, arrange inspection.`;
  else if(!$('identified').checked) $('adjustment').textContent='Confirm the regulator pointer and its scale before making a change.';
  else if(Math.abs(timing.rate)<5) $('adjustment').textContent='Near zero. Check over a full day and in other positions before adjusting.';
  else $('adjustment').textContent=`${source===Source.Demo?'Demo guidance: ':''}${timing.rate<0?'Slow: nudge the scale pointer toward +.':'Fast: nudge the scale pointer toward −.'} Follow the scale pointer; the two-dot end moves opposite. Take a fresh reading after each change.`;
}

function calcAmplitude() {
  amplitude=null;
  const confirmed=$('angle-verified').checked && $('pulses-verified').checked;
  const fold=measurement?.fold;
  const engineEstimate=measurement?.engine===TimingEngine.Tg && measurement.engineAmplitude;
  const engineReady=engineEstimate && [Quality.Usable,Quality.Stable].includes(measurement.quality);
  if(engineReady && !$('pulses-verified').checked) {
    const angle=Number($('lift-angle').value);
    const verified=$('angle-verified').checked && $('lift-angle').checkValidity() && angle===measurement.engineLiftAngle;
    if(verified) amplitude=engineEstimate;
    $('metric-amp').textContent=amplitude?Math.round(amplitude):'–';
    $('note-amp').textContent=amplitude?'tg pulse estimate':'Confirm lift angle below';
    retainMetric(Metric.Amp);
    $('amplitude-feedback').textContent=verified?`tg estimate ${amplitude.toFixed(0)}° with ${angle}° lift angle. Tick lift ${measurement.enginePulses.tickMs.toFixed(2)} ms; tock lift ${measurement.enginePulses.tockMs.toFixed(2)} ms.`:'tg found lift pulses. Confirm the movement’s lift angle below to display amplitude. The starting 53° value is unconfirmed.';
    return;
  }
  let message='Amplitude stays blank until both checks are confirmed.';
  if(!fold) message='A clear, repeatable set of beats is needed to draw the averaged pulses.';
  else if(confirmed && measurement.quality!==Quality.Stable) message='Signal is not stable enough. Improve contact before estimating amplitude.';
  else if(confirmed) {
    const coordinates=['tick-unlock','tick-drop','tock-unlock','tock-drop'];
    const valid=coordinates.every(id=>$(id).value.trim()!=='' && $(id).checkValidity() && Number.isFinite(Number($(id).value)));
    const angle=Number($('lift-angle').value);
    const tickMs=Number($('tick-drop').value)-Number($('tick-unlock').value);
    const tockMs=Number($('tock-drop').value)-Number($('tock-unlock').value);
    const period=measurement.period*1000;
    const tick=amplitudeFromLift(angle,tickMs,period);
    const tock=amplitudeFromLift(angle,tockMs,period);
    if(!valid || !$('lift-angle').checkValidity() || angle<30 || angle>75 || tickMs<=0 || tockMs<=0 || !tick || !tock) message='Keep every marker within the graph, enter a valid lift angle, and place each drop after its unlocking pulse.';
    else if(tick<60 || tick>360 || tock<60 || tock>360) message='The selected pulses imply an implausible amplitude. Check the pulse pair and lift angle.';
    else {amplitude=(tick+tock)/2;message=`Manual estimate: tick ${tick.toFixed(0)}°, tock ${tock.toFixed(0)}° · lift ${tickMs.toFixed(1)} / ${tockMs.toFixed(1)} ms · angle ${angle}°. Pulse identity is your confirmation.`;}
  }
  $('metric-amp').textContent=amplitude?Math.round(amplitude):'–';
  $('note-amp').textContent=amplitude?'Manual pulse estimate':'Needs pulse check';
  $('amplitude-feedback').textContent=message;
  retainMetric(Metric.Amp);
}

function staleAge(at) {
  const seconds=Math.max(0,Math.floor((performance.now()-at)/1000));
  return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
}

// Cached values are display-only. Saving and guidance still use the current measurement.
function retainMetric(metric) {
  const node=$(`metric-${metric}`);
  const current=node.textContent!==EMPTY_METRIC;
  if(current) lastMetrics.set(metric,{text:node.textContent,at:measurementAt});
  const cached=lastMetrics.get(metric);
  const stale=!current && !!cached;
  node.dataset.stale=String(stale);
  node.classList.toggle('stale',stale);
  if(stale) node.textContent=cached.text;
  refreshMetricAge(metric);
}

function refreshMetricAge(metric) {
  const node=$(`metric-${metric}`),cached=lastMetrics.get(metric);
  if(node.dataset.stale!=='true' || !cached) {
    node.removeAttribute('title');
    return;
  }
  const label=`Stale · ${staleAge(cached.at)} ago`;
  $(`note-${metric}`).textContent=label;
  node.setAttribute('title',`Last valid reading. ${label}`);
}

function refreshStaleAges() {
  for(const metric of lastMetrics.keys()) refreshMetricAge(metric);
}

function animateDial(now) {
  if(running && now-lastDialFrame>=DIAL_FRAME_MS) {
    lastDialFrame=now;
    const rect=$('vintage-meter').getBoundingClientRect();
    if(rect.bottom>0 && rect.top<window.innerHeight)drawVintage();
  }
  requestAnimationFrame(animateDial);
}

function canvasContext(canvas) {
  const rect=canvas.getBoundingClientRect();
  const ratio=window.devicePixelRatio||1;
  const w=Math.max(1,Math.round(rect.width)),h=Math.max(1,Math.round(rect.height));
  if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)) {canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
  const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);
  return {ctx,w,h,ratio};
}

function clearCanvas(canvas) { const {ctx,w,h}=canvasContext(canvas);ctx.clearRect(0,0,w,h); }

function recordTrace(value,captureEnd) {
  if(traceGeneration!==generation) {traceHistory=[];traceOrigin=null;traceGeneration=generation;}
  const correction=1+(Number($('calibration').value)||0)/1e6;
  traceEnd=captureEnd/correction;
  if(![Quality.Usable,Quality.Stable].includes(value.quality) || !Number.isFinite(value.period) || value.period<=0) return;
  const offset=(captureEnd-value.duration)/correction;
  const tolerance=(3600/Number($('bph').value))*0.35;
  for(const event of value.events) {
    const point={...event,time:event.time+offset};
    const index=traceHistory.findIndex(previous=>Math.abs(previous.time-point.time)<tolerance);
    if(index>=0) {traceHistory[index]={...point,index:traceHistory[index].index};continue;}
    const nearest=traceHistory.reduce((best,previous)=>!best || Math.abs(previous.time-point.time)<Math.abs(best.time-point.time)?previous:best,null);
    point.index=nearest?nearest.index+Math.round((point.time-nearest.time)/value.period):0;
    traceHistory.push(point);
  }
  traceHistory.sort((a,b)=>a.time-b.time);
  traceOrigin??=traceHistory[0]?.time??null;
  traceHistory=traceHistory.filter(event=>event.time>=traceEnd-120);
}

function drawTrace() {
  drawVintage();
  const {ctx,w,h}=canvasContext($('trace'));ctx.clearRect(0,0,w,h);
  const seconds=Number($('trace-window').value)||60;
  const spanMs=Number($('trace-span').value)||20;
  const left=42,right=w-16,top=20,bottom=h-24;
  ctx.font='10px IBM Plex Mono,monospace';ctx.strokeStyle='#343d36';ctx.fillStyle='#a4aea4';ctx.lineWidth=1;
  for(let i=0;i<=4;i++) {const x=left+(right-left)*i/4;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();}
  for(let i=0;i<=3;i++) {const y=top+(bottom-top)*i/3;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(i===3?'now':`−${Math.round(seconds*(1-i/3))}s`,0,y+3);}
  ctx.fillText('early / fast',left,11);ctx.textAlign='right';ctx.fillText('late / slow',right,11);ctx.textAlign='center';ctx.fillText('0',left+(right-left)/2,h-5);ctx.textAlign='left';
  $('trace-scale').textContent=`${seconds} s down · ${spanMs} ms across`;
  if(traceOrigin===null || traceGeneration!==generation) {ctx.fillStyle='#dbc28e';ctx.fillText('Waiting for a timing lock',left+12,top+27);return;}
  const points=timingStrip(traceHistory,{origin:traceOrigin,end:traceEnd,seconds,spanMs,bph:Number($('bph').value)});
  for(const point of points) {ctx.fillStyle=point.side===0?'#8fb5cb':'#dbc28e';ctx.fillRect(left+point.x*(right-left)-1,top+point.y*(bottom-top)-1,2.5,2.5);}
  if(![Quality.Usable,Quality.Stable].includes(measurement?.quality)) {ctx.fillStyle='#dbc28e';ctx.fillText('Timing lock lost; no new marks',left+12,top+27);}
}

function drawVintage() {
  const {ctx,w,h}=canvasContext($('vintage-meter'));
  const seconds=Number($('trace-window').value)||60,spanMs=Number($('trace-span').value)||20;
  const metrics=[{key:Metric.Bph,label:'BPH',unit:''},{key:Metric.Rate,label:'Rate',unit:'s/day'},{key:Metric.Beat,label:'Beat error',unit:'ms'},{key:Metric.Amp,label:'Amplitude',unit:'°'}].map(metric=>{
    const node=$(`metric-${metric.key}`);
    return {...metric,value:node.textContent,stale:node.dataset.stale==='true'};
  });
  const correction=1+(Number($('calibration').value)||0)/1e6;
  const end=running && sampleRate?totalCount/sampleRate/correction:traceEnd;
  if(vintageGeneration!==generation) {vintageMarks.clear();vintageGeneration=generation;}
  const sweepStart=Math.floor(Math.max(0,end-1e-9)/seconds)*seconds;
  for(const point of traceHistory) if(!vintageMarks.has(point.index))vintageMarks.set(point.index,{...point});
  for(const [index,point] of vintageMarks) if(point.time<sweepStart)vintageMarks.delete(index);
  const sweep=vintageSweep(traceOrigin===null?[]:[...vintageMarks.values()],{origin:traceOrigin??0,end,seconds,spanMs,bph:Number($('bph').value)});
  const locked=[Quality.Usable,Quality.Stable].includes(measurement?.quality);
  const rate=Number(metrics[1].value.replace('−','-'));
  drawVintageMeter(ctx,w,h,{points:sweep.points,progress:sweep.progress,metrics,rate,locked,stale:metrics[1].stale,scale:Number($('vintage-range').value)||50});
  $('vintage-scale').textContent=`${seconds} s · ${spanMs} ms`;
  $('vintage-status').textContent=`${source===Source.Demo?'Demo · ':source===Source.Mic?running?'Live · ':'Stopped · ':''}${metrics[1].stale?$('note-rate').textContent:$('quality').textContent}${sampleRate?` · ${formatHz(sampleRate)}`:''}`;
  $('vintage-meter').setAttribute('aria-label',`Timing dial. ${metrics.map(metric=>`${metric.label} ${metric.value} ${metric.unit}${metric.stale?', stale':''}`).join('. ')}. ${sweep.points.length} measured beat marks. Red cursor sweeps upward; marks stay fixed.`);
}

function currentHistory() { return source===Source.Demo?demoHistory:stableHistory; }

function persistHistory() {
  try {localStorage.setItem(HISTORY_KEY,JSON.stringify(stableHistory.points));historySaved=true;}
  catch {historySaved=false;}
}

function recordHistory() {
  const history=currentHistory(),key=`${source}:${generation}:${$('position').value}`;
  if(key!==historyKey) {history.break();historyKey=key;}
  const timing=selectRate(measurement);
  if(!timing?.stable || measurement.duration<MIN_BASELINE_SECONDS || measurement.clippedRatio>CLIP_LIMIT) {history.break();drawHistory();return;}
  const at=Date.now()-Math.max(0,performance.now()-measurementAt);
  const added=history.add({at,rate:timing.rate,beatError:measurement.beatError,sourceName,position:$('position').value});
  if(added && source!==Source.Demo)persistHistory();
  drawHistory();
}

function drawHistory() {
  const all=currentHistory().points,latest=all.at(-1),seconds=Number($('history-window').value);
  historyView=Number.isFinite(seconds) && latest?all.filter(point=>point.at>=latest.at-seconds*1000):all;
  const wrap=$('history-scroll'),canvas=$('stable-history');
  const follow=wrap.scrollWidth-wrap.clientWidth-wrap.scrollLeft<24;
  const duration=historyView.length>1?(historyView.at(-1).at-historyView[0].at)/1000:0;
  canvas.style.width=`${Math.max(280,wrap.getBoundingClientRect().width-2,Math.min(5000,duration*2))}px`;
  const {ctx,w,h}=canvasContext(canvas);drawStableHistory(ctx,w,h,historyView);
  if(follow)wrap.scrollLeft=wrap.scrollWidth;
  $('export-history').disabled=!all.length;
  $('history-summary').textContent=latest?`${source===Source.Demo?'Demo · ':''}${all.length.toLocaleString()} stable readings · latest ${rateText(latest.rate)} s/day at ${new Date(latest.at).toLocaleTimeString()}`:'Waiting for stable readings';
  $('history-detail').textContent=source===Source.Demo?'Demo history is temporary and stays separate from watch readings.':historySaved?'Stable readings every 5 seconds. Gaps mark lost lock or changed settings. Scroll for older readings; hover for details.':'Browser storage unavailable · export CSV to keep this history.';
  canvas.setAttribute('aria-label',`${historyView.length} stable readings. Rate in seconds per day and beat error in milliseconds. ${latest?`Latest rate ${rateText(latest.rate)}, beat error ${latest.beatError??'unavailable'}.`:''}`);
}

function inspectHistory(event) {
  if(!historyView.length || !Number.isFinite(event.clientX))return;
  const rect=$('stable-history').getBoundingClientRect(),first=historyView[0].at,last=historyView.at(-1).at;
  const time=first+Math.max(0,Math.min(1,(event.clientX-rect.left-65)/(rect.width-85)))*(last-first);
  const point=historyView.reduce((best,value)=>Math.abs(value.at-time)<Math.abs(best.at-time)?value:best);
  $('history-detail').textContent=`${new Date(point.at).toLocaleString()} · ${rateText(point.rate)} s/day · beat error ${Number.isFinite(point.beatError)?point.beatError.toFixed(2)+' ms':'unavailable'} · ${point.sourceName} · ${point.position.replaceAll('-',' ')}`;
}

function exportHistory() {
  const rows=currentHistory().points.map(point=>[new Date(point.at).toISOString(),point.rate,point.beatError??'',point.segment,point.sourceName,point.position].map(value=>`"${String(value).replaceAll('"','""')}"`).join(','));
  download(new Blob([['date,rate_seconds_per_day,beat_error_ms,segment,source,position',...rows].join('\n')],{type:'text/csv'}),'watch-stable-history.csv');
}

function drawPulses() {
  for(const side of ['tick','tock']) {
    const canvas=$(`${side}-pulse`);if(!canvas.getBoundingClientRect().width) continue;
    const {ctx,w,h}=canvasContext(canvas);ctx.clearRect(0,0,w,h);
    const fold=measurement?.fold;
    const left=14,right=w-12,top=22,bottom=h-24;
    ctx.font='9px IBM Plex Mono,monospace';ctx.fillStyle='#a4aea4';ctx.strokeStyle='#343d36';
    for(const ms of [-20,-10,0,10]){const x=left+(ms+25)/37*(right-left);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.fillText(`${ms}`,x-5,h-8);}
    if(!fold){ctx.fillText('Collect clear beats first',20,60);continue;}
    const curve=fold[side];ctx.beginPath();ctx.strokeStyle=side==='tick'?'#dbc28e':'#8fb5cb';ctx.lineWidth=1.5;
    curve.forEach((value,index)=>{const x=left+(fold.startMs+index*fold.stepMs+25)/37*(right-left),y=bottom-value*(bottom-top);if(index===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
    for(const marker of ['unlock','drop']) {
      const value=Number($(`${side}-${marker}`).value),x=left+(value+25)/37*(right-left);
      if(x<left || x>right) continue;
      ctx.strokeStyle=marker==='unlock'?'#94cdb0':'#efaa98';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=ctx.strokeStyle;
      ctx.textAlign=marker==='unlock'?'right':'left';ctx.fillText(marker==='unlock'?'unlock':'drop',x+(marker==='unlock'?-3:3),13);ctx.textAlign='left';
    }
  }
}

function colorAt(level) {
  const t=Math.max(0,Math.min(1,level));
  if(t<.45){const s=t/.45;return [Math.round(15+22*s),Math.round(22+65*s),Math.round(18+52*s)];}
  const s=(t-.45)/.55;return [Math.round(37+202*s),Math.round(87+131*s),Math.round(70+75*s)];
}

const SPECTRUM_COLORS=Array.from({length:256},(_,value)=>colorAt(value/255));

function drawSpectrogram() {
  const {ctx,w,h}=canvasContext($('spectrogram'));
  ctx.clearRect(0,0,w,h);
  if(!spectrumColumns.length)return;
  const duration=Number($('spectrum-window').value);
  const end=spectrumColumns.at(-1).time,start=end-duration;
  const recent=spectrumColumns.filter(column=>column.time>=start);
  const pixels=ctx.createImageData(w,h);
  const low=Number($('low-filter').value),high=Number($('high-filter').value);
  const unfiltered=$('filter-mode').value===FilterMode.Tg;
  const rows=Array.from({length:h},(_,y)=>{
    const hz=(1-y/h)*spectrumMaxHz;
    return {bin:Math.min(recent[0].values.length-1,Math.floor(hz/spectrumMaxHz*recent[0].values.length)),gain:unfiltered || hz>=low && hz<=high?1:0.2};
  });
  let cursor=0;
  for(let x=0;x<w;x++) {
    const from=start+x/w*duration,to=start+(x+1)/w*duration;
    while(cursor<recent.length-1 && recent[cursor+1].time<from)cursor++;
    const first=recent[cursor];
    const values=new Uint8Array(first.values.length);
    if(first.time>=from-duration/w && first.time<=to)values.set(first.values);
    let next=cursor+1;
    while(next<recent.length && recent[next].time<=to){for(let bin=0;bin<values.length;bin++)values[bin]=Math.max(values[bin],recent[next].values[bin]);next++;}
    for(let y=0;y<h;y++) {
      const row=rows[y];
      const rgb=SPECTRUM_COLORS[Math.round(values[row.bin]*row.gain)],at=(y*w+x)*4;
      pixels.data[at]=rgb[0];pixels.data[at+1]=rgb[1];pixels.data[at+2]=rgb[2];pixels.data[at+3]=255;
    }
  }
  spectralSurface.width=w;spectralSurface.height=h;
  spectralSurface.getContext('2d').putImageData(pixels,0,0);ctx.drawImage(spectralSurface,0,0,w,h);
  ctx.fillStyle='#d8e2d5';ctx.font='9px IBM Plex Mono,monospace';
  for(const hz of [4000,8000,12000])if(hz<spectrumMaxHz)ctx.fillText(`${hz/1000}`,6,(1-hz/spectrumMaxHz)*h-3);
  ctx.strokeStyle='#d8e2d522';ctx.lineWidth=1;
  for(let second=1;second<duration;second++){const x=(duration-second)/duration*w;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  $('time-axis').replaceChildren();
  const divisions=duration===5?5:duration===10?5:2;
  for(let i=0;i<=divisions;i++){const span=document.createElement('span');span.textContent=i===divisions?'Latest':`−${duration-duration*i/divisions} s`;$('time-axis').append(span);}
  $('spectrum-empty').hidden=true;$('spectrum-band').textContent=`0–${(spectrumMaxHz/1000).toFixed(0)} kHz`;
}

function drawRecording() {
  if(!sampleCount || running)return;
  const samples=collectSamples(10);
  spectrumColumns=[];spectrumGeneration++;
  spectrumWorker.postMessage({type:'reset',generation:spectrumGeneration,sampleRate});
  spectrumWorker.postMessage({type:'append',generation:spectrumGeneration,sampleRate,samples},[samples.buffer]);
}

function saveLog() {
  if(!measurement || $('save-baseline').disabled) return;
  const timing=selectRate(measurement);
  log.unshift({id:crypto.randomUUID(),date:new Date().toISOString(),source,sourceName,position:$('position').value,rate:timing.rate,bph:timing.bph,rateMethod:timing.method,engine:measurement.engine,engineSampleRate:measurement.engineRate,rateSpread:measurement.rateSpread??timing.spread,beatError:timing.method===RateMethod.Pulse?measurement.beatError:null,amplitude,duration:measurement.duration,sampleRate,captureRate:sourceRate,filterMode:readOptions().filterMode,inputChannel:readOptions().inputChannel,lowHz:readOptions().lowHz,highHz:readOptions().highHz,calibrationPpm:readOptions().calibrationPpm,liftAngle:amplitude?Number($('lift-angle').value):null});
  log=log.slice(0,50);persistLog();renderLog();$('baseline-message').textContent='Baseline saved. Start a fresh take to compare after an adjustment.';
}
function persistLog() {try{localStorage.setItem(LOG_KEY,JSON.stringify(log));}catch{showError('Browser storage is unavailable. Export the log before closing this page.');}}
function renderLog() {
  $('log').replaceChildren();$('log-empty').hidden=log.length>0;$('log-table').hidden=!log.length;$('export-log').disabled=!log.length;
  for(const item of log) {
    const row=document.createElement('tr');const label=document.createElement('td');
    label.textContent=`${item.source===Source.Demo?'DEMO · ':''}${String(item.position).replaceAll('-',' ')}`;
    const small=document.createElement('small');small.textContent=`${new Date(item.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${item.sourceName}`;label.append(small);row.append(label);
    for(const value of [rateText(item.rate),Number.isFinite(item.beatError)?`${item.beatError.toFixed(2)}*`:'–',item.amplitude?`${Math.round(item.amplitude)}°*`:'–']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
    const cell=document.createElement('td'),remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','Delete saved measurement');remove.addEventListener('click',()=>{log=log.filter(entry=>entry.id!==item.id);persistLog();renderLog();});cell.append(remove);row.append(cell);$('log').append(row);
  }
}
function download(blob,name) {const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
function exportLog() {const keys=['date','source','sourceName','position','rate','bph','rateMethod','engine','engineSampleRate','rateSpread','beatError','amplitude','duration','sampleRate','captureRate','filterMode','inputChannel','lowHz','highHz','calibrationPpm','liftAngle'];const csv=[keys.join(','),...log.map(item=>keys.map(key=>`"${String(item[key]??'').replaceAll('"','""')}"`).join(','))].join('\n');download(new Blob([csv],{type:'text/csv'}),'watch-measurements.csv');}

document.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>setStep(Number(button.dataset.step))));
document.querySelectorAll('[data-next]').forEach(button=>button.addEventListener('click',()=>setStep(Number(button.dataset.next))));
$('connect').addEventListener('click',connectMic);$('audio-file').addEventListener('change',openFile);
$('change-source').addEventListener('click',()=>setStep(0));
$('demo').addEventListener('click',loadDemo);$('demo-preset').addEventListener('change',loadDemo);
$('stop').addEventListener('click',async()=>{await stopCapture();await analyse();$('source-state').textContent='Take stopped';});
$('clear').addEventListener('click',async()=>{sourceRequest++;await stopCapture();resetData();source=Source.None;sourceName='';sampleRate=0;sourceRate=null;updateSource();updateClock();setStep(0);showError();$('source-state').textContent='Choose an input';$('capture-details').textContent='No capture connected.';$('demo').disabled=false;$('demo').textContent='Try demo';});
$('start-comparison').addEventListener('click',()=>{if(running){resetData();setStep(2);}else if(source===Source.Demo){void loadDemo();}else{setStep(0);$('feedback').textContent='Reconnect the microphone or open a new recording for an independent measurement.';}});
$('identified').addEventListener('change',renderMetrics);
$('save-baseline').addEventListener('click',saveLog);$('export-log').addEventListener('click',exportLog);
$('download-audio').addEventListener('click',()=>{const data=collectSamples();download(new Blob([encodeWav(data,sampleRate)],{type:'audio/wav'}),`${source===Source.Demo?'demo-':''}watch-${sampleRate}hz.wav`);});
for(const id of ['low-filter','high-filter']) $(id).addEventListener('input',()=>{
  let low=Number($('low-filter').value),high=Number($('high-filter').value);
  if(high<=low+500){if(id==='low-filter')$('high-filter').value=String(low+1000);else $('low-filter').value=String(high-1000);}
  low=Number($('low-filter').value);high=Number($('high-filter').value);
  $('low-label').textContent=formatHz(low);$('high-label').textContent=formatHz(high);
  lastMetrics.clear();engine?.setBand(low,high);$('pulses-verified').checked=false;generation++;measurement=null;renderMetrics();drawPulses();
});
for(const id of ['low-filter','high-filter']) $(id).addEventListener('change',()=>{void analyse();drawSpectrogram();});
$('filter-mode').addEventListener('change',()=>{
  lastMetrics.clear();updateFilters();generation++;measurement=null;$('pulses-verified').checked=false;
  void analyse();renderMetrics();drawPulses();drawTrace();drawSpectrogram();
});
$('input-channel').addEventListener('change',()=>{
  if(running) {void connectMic();return;}
  if(!fileChannels.length) return;
  const request=++sourceRequest;
  void useRecording(selectChannel(fileChannels,$('input-channel').value),sampleRate,source,sourceName,sourceRate,request,fileChannels);
});
$('spectrum-window').addEventListener('change',()=>{drawSpectrogram();drawTrace();});
for(const id of ['trace-window','trace-span']) $(id).addEventListener('change',drawTrace);
for(const id of ['bph','calibration','lift-angle']) $(id).addEventListener('change',()=>{lastMetrics.clear();generation++;measurement=null;$('pulses-verified').checked=false;void analyse();renderMetrics();});
for(const id of ['device','sample-rate']) $(id).addEventListener('change',()=>{if(running)void connectMic();});
for(const id of ['lift-angle','angle-verified','pulses-verified','tick-unlock','tick-drop','tock-unlock','tock-drop']) $(id).addEventListener('input',()=>{lastMetrics.delete(Metric.Amp);calcAmplitude();drawPulses();drawVintage();});
$('amplitude-details').addEventListener('toggle',drawPulses);
$('vintage-range').addEventListener('change',drawVintage);
$('history-window').addEventListener('change',drawHistory);
$('stable-history').addEventListener('pointermove',inspectHistory);
$('stable-history').addEventListener('pointerleave',drawHistory);
$('export-history').addEventListener('click',exportHistory);
$('clear-history').addEventListener('click',()=>{currentHistory().clear();if(source!==Source.Demo)persistHistory();drawHistory();});
let resizeTimer;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{drawTrace();drawPulses();drawSpectrogram();drawHistory();},150);});
window.addEventListener('pagehide',()=>{void stopCapture();});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>{void listDevices();});
function updateFilters() {
  const custom=$('filter-mode').value===FilterMode.Custom;
  $('low-filter').disabled=!custom;$('high-filter').disabled=!custom;
  $('spectrum-mode').textContent=custom?'Raw spectrum · custom band highlighted':'Raw spectrum · tg default, no extra bandpass';
}
setInterval(refreshStaleAges,STALE_REFRESH_MS);
requestAnimationFrame(animateDial);
updateFilters();renderLog();renderMetrics();drawTrace();drawHistory();void listDevices();
