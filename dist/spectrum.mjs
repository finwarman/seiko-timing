const COLUMN_RATE=200;
const BIN_COUNT=96;
const MAX_HZ=16000;
const FLOOR_DB=-100;
const CEILING_DB=-20;

function fftMagnitude(input) {
  const size=input.length,real=Float64Array.from(input),imag=new Float64Array(size);
  for(let i=1,j=0;i<size;i++){let bit=size>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[real[i],real[j]]=[real[j],real[i]];}
  for(let span=2;span<=size;span<<=1){const angle=-2*Math.PI/span;for(let start=0;start<size;start+=span){for(let j=0;j<span/2;j++){const c=Math.cos(angle*j),s=Math.sin(angle*j),at=start+j+span/2;const r=real[at]*c-imag[at]*s,m=real[at]*s+imag[at]*c;real[at]=real[start+j]-r;imag[at]=imag[start+j]-m;real[start+j]+=r;imag[start+j]+=m;}}}
  return Float32Array.from(real.subarray(0,size/2),(value,index)=>Math.hypot(value,imag[index]));
}

export function spectralColumns(samples,sampleRate) {
  const fftSize=2**Math.ceil(Math.log2(sampleRate*0.02));
  const hop=Math.max(1,Math.round(sampleRate/COLUMN_RATE));
  const maxHz=Math.min(MAX_HZ,sampleRate/2);
  const windowed=new Float32Array(fftSize);
  const columns=[];
  let consumed=0;
  for(let start=0;start+fftSize<=samples.length;start+=hop) {
    for(let i=0;i<fftSize;i++)windowed[i]=samples[start+i]*(0.5-0.5*Math.cos(2*Math.PI*i/(fftSize-1)));
    const magnitudes=fftMagnitude(windowed);
    const column=new Uint8Array(BIN_COUNT);
    for(let bin=0;bin<BIN_COUNT;bin++) {
      const first=Math.max(1,Math.floor(bin/BIN_COUNT*maxHz/sampleRate*fftSize));
      const last=Math.min(magnitudes.length,Math.ceil((bin+1)/BIN_COUNT*maxHz/sampleRate*fftSize));
      let peak=0;
      for(let i=first;i<last;i++)peak=Math.max(peak,magnitudes[i]);
      const dB=20*Math.log10(Math.max(1e-12,peak/fftSize));
      column[bin]=Math.round(255*Math.max(0,Math.min(1,(dB-FLOOR_DB)/(CEILING_DB-FLOOR_DB))));
    }
    columns.push(column);consumed=start+hop;
  }
  return {columns,consumed,hop,fftSize,bins:BIN_COUNT,maxHz};
}
