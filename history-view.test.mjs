import test from 'node:test';
import assert from 'node:assert/strict';
import {drawVintageMeter} from './dist/vintage-meter.mjs';
import {StableHistory} from './dist/stable-history.mjs';
import {vintageSweep} from './dist/vintage-sweep.mjs';

const OPTIONS={origin:0,end:10,seconds:60,spanMs:20,bph:21600};

test('existing triangles stay fixed while the red cursor moves upward',()=>{
  const events=[{index:12,time:2},{index:24,time:4}];
  const first=vintageSweep(events,OPTIONS),later=vintageSweep(events,{...OPTIONS,end:20});
  assert.deepEqual(first.points,later.points);
  assert.ok(later.progress>first.progress);
  assert.ok(first.points[0].y>first.points[1].y);
  assert.ok(first.points.every(point=>Math.abs(point.x-0.5)<1e-9));
});

test('a completed sweep starts a fresh page and excludes old and future beats',()=>{
  const view=vintageSweep([{index:0,time:1},{index:366,time:61},{index:378,time:63}],{...OPTIONS,end:62});
  assert.equal(view.start,60);
  assert.deepEqual(view.points.map(point=>point.index),[366]);
  assert.ok(view.progress<0.04);
});

test('a gaining watch leans right in the upward sweep',()=>{
  const events=[12,24].map(index=>({index,time:index/6/(1+24/86400)}));
  const points=vintageSweep(events,OPTIONS).points;
  assert.ok(points[1].x>points[0].x);
});

test('stable history throttles snapshots and breaks lines after lost lock',()=>{
  const history=new StableHistory();
  assert.equal(history.add({at:10000,rate:12,beatError:0.4}),true);
  assert.equal(history.add({at:12000,rate:99,beatError:5}),false);
  history.break();history.break();
  assert.equal(history.add({at:16000,rate:10,beatError:0.3}),true);
  assert.notEqual(history.points[0].segment,history.points[1].segment);
  assert.equal(history.points.length,2);
});

test('restored history rejects corrupt rows and starts a separate session',()=>{
  const history=new StableHistory([{at:1000,rate:12,beatError:0.3,segment:4},{at:'bad',rate:0,segment:4}]);
  history.add({at:8000,rate:9,beatError:NaN});
  const points=history.points;
  assert.equal(points.length,2);
  assert.equal(points[1].beatError,null);
  assert.notEqual(points[0].segment,points[1].segment);
  points.pop();assert.equal(history.points.length,2);
  history.clear();assert.deepEqual(history.points,[]);
});


test('cursor frames reuse the paper and scale until their geometry changes',()=>{
  let layers=0,dots=0;
  const layer=new Proxy({arc(){dots++;}},{get:(target,key)=>target[key]??(()=>{})});
  const document={createElement(){layers++;return {getContext:()=>layer};}};
  const ctx=new Proxy({canvas:{width:320,ownerDocument:document}},{get:(target,key)=>target[key]??(()=>{})});
  const view={scale:50,rate:24,stale:false,metrics:[],points:[],progress:0,locked:true};
  drawVintageMeter(ctx,320,400,view);
  const initialDots=dots;
  for(let frame=1;frame<=20;frame++)drawVintageMeter(ctx,320,400,{...view,progress:frame/60});
  assert.equal(layers,1);
  assert.equal(dots,initialDots);
  drawVintageMeter(ctx,320,400,{...view,scale:300});
  assert.equal(layers,2);
  assert.ok(dots>initialDots);
});
