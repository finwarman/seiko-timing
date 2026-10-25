import {timingStrip} from './timing-strip.mjs';

/** Each page fills bottom to top. A recorded mark never moves within that page. */
export function vintageSweep(events,options) {
  const {end,seconds}=options;
  const start=Math.floor(Math.max(0,end-1e-9)/seconds)*seconds;
  const points=timingStrip(events.filter(event=>event.time<=end),{...options,end:start+seconds}).map(point=>({...point,x:1-point.x,y:1-point.y}));
  return {points,progress:Math.max(0,Math.min(1,(end-start)/seconds)),start};
}
