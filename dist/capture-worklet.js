import {InputChannel,selectChannel} from './channels.mjs';

class WatchCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.selection=options.processorOptions?.selection ?? InputChannel.First;
    this.buffer=new Float32Array(8192);this.offset=0;this.firstFrame=0;this.energy=[];
  }
  process(inputs) {
    const channels=inputs[0];
    if(!channels?.length) return true;
    if(this.energy.length!==channels.length) this.energy=channels.map(()=>0);
    const selected=selectChannel(channels,this.selection);
    for(let i=0;i<selected.length;i++) {
      if(this.offset===0) this.firstFrame=currentFrame+i;
      channels.forEach((channel,index)=>{this.energy[index]+=channel[i]*channel[i];});
      this.buffer[this.offset++]=selected[i];
      if(this.offset!==this.buffer.length) continue;
      this.port.postMessage({samples:this.buffer.buffer,frame:this.firstFrame,levels:this.energy.map(energy=>20*Math.log10(Math.max(1e-8,Math.sqrt(energy/this.buffer.length))))},[this.buffer.buffer]);
      this.buffer=new Float32Array(8192);this.offset=0;this.energy.fill(0);
    }
    return true;
  }
}
registerProcessor('watch-capture',WatchCapture);
