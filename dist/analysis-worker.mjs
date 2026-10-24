import {makeDemo} from './dsp.mjs';
import {createAnalyzer} from './watch-engine.mjs';
const Job=Object.freeze({Analyze:'analyze',Demo:'demo'});
const analyzer=createAnalyzer();
self.onmessage=async event=>{
  const {id,type,samples,sampleRate,options}=event.data;
  try {
    if(type===Job.Demo) { const demo=makeDemo(options); self.postMessage({id,type,samples:demo,sampleRate:options.sampleRate},[demo.buffer]); return; }
    const result=(await analyzer).analyze(new Float32Array(samples),sampleRate,options);
    self.postMessage({id,type,result});
  } catch(error) { self.postMessage({id,error:error.message}); }
};
