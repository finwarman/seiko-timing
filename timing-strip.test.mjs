import test from 'node:test';
import assert from 'node:assert/strict';
import { timingStrip } from './dist/timing-strip.mjs';

const OPTIONS={origin:0,end:60,seconds:60,spanMs:20,bph:21600};
const events=(rate=0,beatError=0)=>Array.from({length:360},(_,index)=>({index,time:index/6/(1+rate/86400)+(index%2?beatError/1000:0)}));

test('zero rate makes a vertical strip with time moving down',()=>{
  const points=timingStrip(events(),OPTIONS);
  assert.ok(points.every(point=>Math.abs(point.x-0.5)<1e-9));
  assert.ok(points.at(-1).y>points[0].y);
});

test('gain slopes left and loss slopes right before the strip wraps',()=>{
  const config={...OPTIONS,end:10,seconds:10};
  const fast=timingStrip(events(24),config),slow=timingStrip(events(-24),config);
  assert.ok(fast.at(-1).x<fast[0].x);
  assert.ok(slow.at(-1).x>slow[0].x);
});

test('alternating beat error produces two separated vertical tracks',()=>{
  const points=timingStrip(events(0,1.2),OPTIONS);
  for(const point of points) assert.ok(Math.abs(point.phaseMs-(point.index%2?1.2:0))<1e-8);
});

test('large rate wraps by phase width without losing the beat index',()=>{
  const points=timingStrip(events(-900),OPTIONS);
  assert.ok(points.every(point=>point.x>=0 && point.x<=1));
  assert.ok(points.length>300);
  const last=points.at(-1);
  const phase=(last.time-last.index/6)*1000;
  assert.ok(Math.abs((((phase+10)%20+20)%20-10)-last.phaseMs)<1e-8);
});
