const INK='#393529';
const PAPER='#fff1b9';
const RED='#c74b37';
const FAN_HALF_ANGLE=32*Math.PI/180;
const GRID_PITCH=12;
const METRIC_LINE=27;
const dialBackgrounds=new WeakMap();

function triangle(ctx,x,y,size) {
  ctx.beginPath();ctx.moveTo(x,y-size);ctx.lineTo(x-size*0.86,y+size/2);ctx.lineTo(x+size*0.86,y+size/2);ctx.closePath();ctx.fill();
}

function drawPaper(ctx,w,h) {
  ctx.fillStyle=PAPER;ctx.fillRect(0,0,w,h);
  ctx.fillStyle='#b5a46d';
  const rowHeight=GRID_PITCH*Math.sqrt(3)/2;
  ctx.beginPath();
  for(let row=0;row*rowHeight<h;row++) {
    for(let x=(row%2)*GRID_PITCH/2;x<w;x+=GRID_PITCH) {
      ctx.moveTo(x+0.6,row*rowHeight);ctx.arc(x,row*rowHeight,0.6,0,Math.PI*2);
    }
  }
  ctx.fill();
}

function drawDial(ctx,w,h,scale) {
  const apex={x:w/2,y:h-23};
  const radius=Math.min(w*0.9,h-80);
  const angle=value=>-Math.PI/2+FAN_HALF_ANGLE*value;
  const position=(a,r)=>({x:apex.x+Math.cos(a)*r,y:apex.y+Math.sin(a)*r});
  ctx.strokeStyle=INK;ctx.fillStyle=INK;ctx.lineWidth=1;
  ctx.beginPath();ctx.arc(apex.x,apex.y,radius,angle(-1),angle(1));ctx.stroke();
  for(let i=0;i<=50;i++) {
    const a=angle(i/25-1),major=i%5===0;
    const outer=position(a,radius),inner=position(a,radius-(major?12:5));
    ctx.beginPath();ctx.moveTo(outer.x,outer.y);ctx.lineTo(inner.x,inner.y);ctx.stroke();
    if(!major) continue;
    const label=position(a,radius+16),value=Math.round(scale*(i/25-1));
    ctx.font=`${w<330?9:11}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    ctx.fillText(value>0?`+${value}`:String(value),Math.max(15,Math.min(w-15,label.x)),label.y+4);
  }
  for(const side of [-1,1]) {
    const edge=position(angle(side),radius);
    ctx.beginPath();ctx.moveTo(edge.x,edge.y);ctx.lineTo(apex.x,apex.y);ctx.stroke();
  }
  ctx.save();ctx.setLineDash([4,5]);ctx.strokeStyle='#8b805b';
  ctx.beginPath();ctx.moveTo(apex.x,apex.y-radius+22);ctx.lineTo(apex.x,apex.y);ctx.stroke();ctx.restore();
  ctx.fillStyle=INK;triangle(ctx,apex.x,apex.y,5);
  return {top:apex.y-radius,apex};
}

function drawNeedle(ctx,w,h,scale,rate,stale) {
  const apex={x:w/2,y:h-23},radius=Math.min(w*0.9,h-80);
  const angle=-Math.PI/2+FAN_HALF_ANGLE*Math.max(-1,Math.min(1,rate/scale));
  if(!Number.isFinite(rate))return;
  const tip={x:apex.x+Math.cos(angle)*(radius-17),y:apex.y+Math.sin(angle)*(radius-17)};
  ctx.save();ctx.globalAlpha=stale?0.22:0.55;
  ctx.strokeStyle=INK;ctx.beginPath();ctx.moveTo(apex.x,apex.y);ctx.lineTo(tip.x,tip.y);ctx.stroke();
  ctx.fillStyle=INK;triangle(ctx,tip.x,tip.y,4);ctx.restore();
}

function drawBackground(ctx,w,h,scale) {
  const document=ctx.canvas?.ownerDocument;
  if(!document) {drawPaper(ctx,w,h);return drawDial(ctx,w,h,scale);}
  const ratio=ctx.canvas.width/w;
  const key=`${w}:${h}:${scale}:${ratio}:${document.fonts?.status}`;
  let cached=dialBackgrounds.get(ctx);
  if(cached?.key!==key) {
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);
    const layer=canvas.getContext('2d');layer.setTransform(ratio,0,0,ratio,0,0);
    drawPaper(layer,w,h);
    cached={key,canvas,dial:drawDial(layer,w,h,scale)};
    dialBackgrounds.set(ctx,cached);
  }
  ctx.drawImage(cached.canvas,0,0,w,h);
  return cached.dial;
}

/** Draw the same measured events as the strip, with fixed marks and a red cursor sweeping upward. */
export function drawVintageMeter(ctx,w,h,view) {
  ctx.save();
  const dial=drawBackground(ctx,w,h,view.scale);
  drawNeedle(ctx,w,h,view.scale,view.rate,view.stale);
  const firstRow=dial.top+47;
  ctx.fillStyle='#fff1b9d9';ctx.fillRect(w*0.17,firstRow-19,w*0.69,METRIC_LINE*4+5);
  view.metrics.forEach((metric,index)=>{
    const y=firstRow+index*METRIC_LINE;
    ctx.save();ctx.globalAlpha=metric.stale?0.4:1;ctx.fillStyle=INK;
    ctx.textAlign='left';ctx.font=`${Math.max(12,w*0.039)}px DM Sans,sans-serif`;ctx.fillText(metric.label,w*0.2,y);
    ctx.textAlign='right';ctx.font=`${Math.max(15,w*0.051)}px IBM Plex Mono,monospace`;ctx.fillText(metric.value,w*0.73,y);
    ctx.textAlign='left';ctx.font='10px IBM Plex Mono,monospace';ctx.fillText(metric.unit,w*0.75,y);ctx.restore();
  });
  const top=18,bottom=dial.apex.y-8,margin=13;
  const redLine=bottom-view.progress*(bottom-top);
  ctx.save();ctx.beginPath();ctx.rect(margin,top,w-margin*2,bottom-top);ctx.clip();
  ctx.globalAlpha=view.locked?0.85:0.3;
  for(const point of view.points) {
    ctx.fillStyle=point.side===0?RED:'#df7051';
    triangle(ctx,margin+point.x*(w-margin*2),top+point.y*(bottom-top),4.1);
  }
  ctx.restore();
  ctx.strokeStyle=RED;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,redLine);ctx.lineTo(w,redLine);ctx.stroke();
  ctx.fillStyle='#736542';ctx.font='9px IBM Plex Mono,monospace';ctx.textAlign='left';ctx.fillText('NOW',8,Math.max(11,redLine-6));
  ctx.textAlign='right';ctx.fillText('SWEEP ↑',w-8,h-8);
  if(!view.points.length) {
    ctx.textAlign='center';ctx.fillStyle='#736542';ctx.font='12px DM Sans,sans-serif';ctx.fillText('Waiting for measured beats',w/2,h*0.7);
  }
  ctx.restore();
}
