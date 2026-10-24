import {InputChannel,selectChannel} from './channels.mjs';

const SampleRate = Object.freeze({ Default: 192000, Maximum: 384000 });
const WavFormat = Object.freeze({ Pcm: 1, Float: 3, Extensible: 65534 });
const RIFF_HEADER_BYTES = 12;
const WAV_HEADER_BYTES = 44;
const MAX_FILE_BYTES = 150 * 1024 * 1024;

export function chooseRate(request, capabilities = {}) {
  const desired = request === 'max' ? SampleRate.Maximum : Number(request);
  const available = capabilities.sampleRate?.max;
  if (available) return Math.min(desired, available);
  return request === 'max' ? SampleRate.Default : desired;
}

export function parseWav(buffer, selection = InputChannel.First) {
  if (buffer.byteLength < RIFF_HEADER_BYTES) return null;
  const data = new DataView(buffer);
  const text = (offset, count) => String.fromCharCode(...new Uint8Array(buffer, offset, count));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') return null;
  let format;
  let payload;
  for (let cursor = RIFF_HEADER_BYTES; cursor + 8 <= buffer.byteLength;) {
    const id = text(cursor, 4);
    const size = data.getUint32(cursor + 4, true);
    const start = cursor + 8;
    if (start + size > buffer.byteLength) throw new Error('This WAV is truncated. Export the recording again.');
    if (id === 'fmt ' && size >= 16) {
      let code = data.getUint16(start, true);
      if (code === WavFormat.Extensible && size >= 40) code = data.getUint16(start + 24, true);
      format = {code, channels:data.getUint16(start+2,true), rate:data.getUint32(start+4,true), stride:data.getUint16(start+12,true), bits:data.getUint16(start+14,true)};
    }
    if (id === 'data') payload = {start, size};
    cursor = start + size + (size % 2);
  }
  if (!format || !payload) throw new Error('This WAV is missing its format or audio data.');
  const {code,channels,rate,stride,bits} = format;
  const byteSize = bits / 8;
  const supported = code === WavFormat.Pcm ? [8,16,24,32].includes(bits) : code === WavFormat.Float && bits === 32;
  if (!supported) return null;
  if (channels < 1 || channels > 32 || rate < 8000 || rate > SampleRate.Maximum || stride !== channels*byteSize) throw new Error('This WAV has invalid channel or sample-rate metadata.');
  const count = Math.floor(payload.size / stride);
  const audioChannels = Array.from({length:channels}, () => new Float32Array(count));
  for (let frame = 0; frame < count; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const at = payload.start + frame*stride + channel*byteSize;
      let value;
      if (code === WavFormat.Float) value = data.getFloat32(at,true);
      else if (bits === 8) value = (data.getUint8(at)-128)/128;
      else if (bits === 16) value = data.getInt16(at,true)/32768;
      else if (bits === 24) { let n = data.getUint8(at) | data.getUint8(at+1)<<8 | data.getUint8(at+2)<<16; if (n & 0x800000) n -= 0x1000000; value=n/8388608; }
      else value = data.getInt32(at,true)/2147483648;
      audioChannels[channel][frame] = Number.isFinite(value) ? value : 0;
    }
  }
  return {samples:selectChannel(audioChannels,selection),audioChannels,sampleRate:rate,sourceRateKnown:true,channels};
}

export function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length*bytesPerSample);
  const view = new DataView(buffer);
  const write = (at, text) => { for(let i=0;i<text.length;i++) view.setUint8(at+i,text.charCodeAt(i)); };
  write(0,'RIFF'); view.setUint32(4,buffer.byteLength-8,true); write(8,'WAVE'); write(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,WavFormat.Pcm,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*bytesPerSample,true);
  view.setUint16(32,bytesPerSample,true); view.setUint16(34,16,true); write(36,'data');
  view.setUint32(40,samples.length*bytesPerSample,true);
  for (let i=0;i<samples.length;i++) {
    const value = Math.max(-1,Math.min(1,samples[i]));
    view.setInt16(WAV_HEADER_BYTES+i*bytesPerSample,Math.round(value*(value<0?32768:32767)),true);
  }
  return buffer;
}

export async function readAudio(file, selection = InputChannel.First) {
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose a recording smaller than 150 MB.');
  const buffer = await file.arrayBuffer();
  const wav = parseWav(buffer,selection);
  if (wav) return wav;
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer);
    const audioChannels = Array.from({length:decoded.numberOfChannels}, (_,channel) => decoded.getChannelData(channel).slice());
    return {samples:selectChannel(audioChannels,selection),audioChannels,sampleRate:decoded.sampleRate,sourceRateKnown:false,channels:decoded.numberOfChannels};
  } finally { await context.close(); }
}

export class MicCapture {
  #stream;
  #context;
  #processor;
  #highpass;
  #lowpass;
  #analyser;
  #onSamples;
  #onEnded;

  constructor(onSamples, onEnded) { this.#onSamples=onSamples; this.#onEnded=onEnded; }
  get analyser() { return this.#analyser; }

  async start(deviceId, request, selection = InputChannel.First) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs a secure browser page. Open the localhost link in the in-app browser.');
    const audio = {channelCount:{ideal:2},sampleRate:{ideal:chooseRate(request)},echoCancellation:false,noiseSuppression:false,autoGainControl:false};
    if (deviceId) audio.deviceId = {exact:deviceId};
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({audio});
      const track = this.#stream.getAudioTracks()[0];
      const rate = chooseRate(request,track.getCapabilities?.() ?? {});
      try { await track.applyConstraints({sampleRate:{ideal:rate},echoCancellation:false,noiseSuppression:false,autoGainControl:false}); } catch { /* Keep the usable negotiated stream when a device rejects optional constraints. */ }
      const settings=track.getSettings();
      const config = settings.sampleRate ? {sampleRate:settings.sampleRate} : {};
      try { this.#context=new AudioContext(config); } catch { this.#context=new AudioContext(); }
      await this.#context.audioWorklet.addModule('capture-worklet.js');
      this.#processor=new AudioWorkletNode(this.#context,'watch-capture',{channelCount:2,channelCountMode:'max',processorOptions:{selection}});
      this.#processor.port.onmessage=event=>this.#onSamples(new Float32Array(event.data.samples),this.#context.sampleRate,event.data.frame,event.data.levels);
      const source=this.#context.createMediaStreamSource(this.#stream);
      const mute=this.#context.createGain(); mute.gain.value=0;
      source.connect(this.#processor).connect(mute).connect(this.#context.destination);
      this.#highpass=this.#context.createBiquadFilter(); this.#highpass.type='highpass'; this.#highpass.Q.value=Math.SQRT1_2;
      this.#lowpass=this.#context.createBiquadFilter(); this.#lowpass.type='lowpass'; this.#lowpass.Q.value=Math.SQRT1_2;
      this.#analyser=this.#context.createAnalyser(); this.#analyser.fftSize=2048; this.#analyser.smoothingTimeConstant=0.15; this.#analyser.minDecibels=-100; this.#analyser.maxDecibels=-10;
      source.connect(this.#highpass).connect(this.#lowpass).connect(this.#analyser).connect(mute);
      await this.#context.resume();
      track.onended=()=>this.#onEnded('The microphone disconnected. Reconnect it to start a new take.');
      return {captureRate:settings.sampleRate ?? null,processingRate:this.#context.sampleRate,settings,label:track.label,requestedRate:rate};
    } catch(error) { await this.stop(); throw error; }
  }

  setBand(low,high) {
    if (!this.#context) return;
    const ceiling=this.#context.sampleRate*0.45;
    this.#highpass.frequency.value=Math.min(low,ceiling*0.8);
    this.#lowpass.frequency.value=Math.min(high,ceiling);
  }

  async stop() {
    if(this.#processor) this.#processor.port.onmessage=null;
    if(this.#stream) { this.#stream.getTracks().forEach(track=>{track.onended=null;track.stop();}); }
    if(this.#context && this.#context.state!=='closed') await this.#context.close();
    this.#stream=null; this.#context=null; this.#analyser=null; this.#processor=null;
  }
}
