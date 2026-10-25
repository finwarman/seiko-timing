const SAMPLE_INTERVAL_MS=5000;
const MAX_HISTORY_POINTS=20000;

/** Stable measurements survive capture resets; segments prevent lines across lost locks. */
export class StableHistory {
  #points=[];
  #segment=0;
  #inSegment=false;

  constructor(points=[]) {
    this.#points=points.filter(point=>Number.isFinite(point.at) && Number.isFinite(point.rate) && Number.isInteger(point.segment)).map(point=>({...point,beatError:Number.isFinite(point.beatError) && point.beatError>=0?point.beatError:null})).slice(-MAX_HISTORY_POINTS);
    this.#segment=this.#points.reduce((latest,point)=>Math.max(latest,point.segment),0)+1;
  }

  get points() { return this.#points.slice(); }

  add(point) {
    if(!Number.isFinite(point.at) || !Number.isFinite(point.rate)) return false;
    const previous=this.#points.at(-1);
    if(previous && point.at-previous.at<SAMPLE_INTERVAL_MS) return false;
    this.#points.push({...point,beatError:Number.isFinite(point.beatError) && point.beatError>=0?point.beatError:null,segment:this.#segment});
    this.#points=this.#points.slice(-MAX_HISTORY_POINTS);
    this.#inSegment=true;
    return true;
  }

  break() {
    if(!this.#inSegment) return;
    this.#segment++;this.#inSegment=false;
  }

  clear() { this.#points=[];this.#segment++;this.#inSegment=false; }
}

export function drawStableHistory(ctx,w,h,points) {
  const left=65,right=w-20,top=20,rowHeight=(h-50)/2;
  const first=points[0]?.at??0,last=points.at(-1)?.at??first;
  const span=Math.max(1000,last-first);
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#101512';ctx.fillRect(0,0,w,h);
  for(const [index,series] of [{key:'rate',label:'RATE · s/day',color:'#dbc28e',minimum:2},{key:'beatError',label:'BEAT ERROR · ms',color:'#8fb5cb',minimum:0.2}].entries()) {
    const values=points.map(point=>point[series.key]).filter(Number.isFinite);
    const low=values.length?Math.min(...values):0,high=values.length?Math.max(...values):1;
    const padding=Math.max(series.minimum,(high-low)*0.15);
    const min=low-padding,max=high+padding;
    const yTop=top+index*rowHeight+17,yBottom=top+(index+1)*rowHeight-17;
    const y=value=>yBottom-(value-min)/(max-min)*(yBottom-yTop);
    ctx.font='9px IBM Plex Mono,monospace';ctx.textAlign='left';ctx.fillStyle=series.color;ctx.fillText(series.label,left,yTop-8);
    ctx.fillStyle='#a4aea4';ctx.fillText(max.toFixed(index?2:1),4,yTop+4);ctx.fillText(min.toFixed(index?2:1),4,yBottom+4);
    ctx.strokeStyle='#343d36';ctx.lineWidth=1;
    for(const yy of [yTop,yBottom]) {ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();}
    let previous=null;
    for(const point of points) {
      const value=point[series.key];
      if(!Number.isFinite(value)) {previous=null;continue;}
      const x=left+(point.at-first)/span*(right-left),yy=y(value);
      ctx.strokeStyle=series.color;ctx.fillStyle=series.color;ctx.lineWidth=1.5;
      if(previous && previous.point.segment===point.segment && point.at-previous.point.at<=30000) {ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(x,yy);ctx.stroke();}
      ctx.beginPath();ctx.arc(x,yy,2.2,0,Math.PI*2);ctx.fill();previous={point,x,y:yy};
    }
  }
  ctx.font='9px IBM Plex Mono,monospace';ctx.fillStyle='#a4aea4';ctx.textAlign='center';
  for(let x=left;x<=right;x+=160) {
    const date=new Date(first+(x-left)/(right-left)*span);
    ctx.fillText(points.length?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'',x,h-7);
  }
  if(!points.length) {ctx.textAlign='left';ctx.fillText('Waiting for stable readings',left,top+rowHeight/2);}
}
