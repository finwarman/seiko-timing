import {spectralColumns} from './spectrum.mjs';
let pending=new Float32Array();
let rate=0;
let processed=0;
let generation=0;
self.onmessage=event=>{
  const data=event.data;
  if(data.type==='reset' || data.generation!==generation || data.sampleRate!==rate) {
    pending=new Float32Array();processed=0;rate=data.sampleRate||0;generation=data.generation;
  }
  if(data.type==='reset')return;
  const next=new Float32Array(pending.length+data.samples.length);next.set(pending);next.set(data.samples,pending.length);
  const result=spectralColumns(next,rate);
  const start=processed/rate;
  pending=next.slice(result.consumed);processed+=result.consumed;
  self.postMessage({generation,columns:result.columns,start,hopSeconds:result.hop/rate,maxHz:result.maxHz,bins:result.bins});
};
