import test from 'node:test';
import assert from 'node:assert/strict';
import {spectralColumns} from './dist/spectrum.mjs';

test('continuous STFT covers every captured sample across chunk boundaries',()=>{
  const rate=48000;
  const input=new Float32Array(rate);
  for(let i=0;i<input.length;i++)input[i]=0.1*Math.sin(2*Math.PI*6000*i/rate);
  const full=spectralColumns(input,rate);
  assert.ok(full.columns.length>190);
  const last=full.columns.at(-1);
  const strongest=last.indexOf(Math.max(...last));
  assert.ok(Math.abs(strongest/full.bins*full.maxHz-6000)<300);
  assert.ok(full.consumed<=input.length);
  assert.ok(input.length-full.consumed<full.fftSize);
});

test('a quiet sample has no invented spectral energy',()=>{
  const result=spectralColumns(new Float32Array(4800),48000);
  assert.ok(result.columns.length>0);
  assert.equal(Math.max(...result.columns.flatMap(column=>Array.from(column))),0);
});
