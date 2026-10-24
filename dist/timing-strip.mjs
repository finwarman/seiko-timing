/** Phase is early/late arrival against nominal BPH. Time runs down the strip. */
export function timingStrip(events,options) {
  const {origin,end,seconds,spanMs,bph}=options;
  const period=3600/bph;
  const start=end-seconds;
  return events.filter(event=>event.time>=start && event.time<=end).map(event=>{
    const elapsed=event.time-origin;
    const index=Number.isFinite(event.index)?event.index:Math.round(elapsed/period);
    const phase=(elapsed-index*period)*1000;
    const wrapped=((phase+spanMs/2)%spanMs+spanMs)%spanMs-spanMs/2;
    return {...event,phaseMs:wrapped,x:0.5+wrapped/spanMs,y:(event.time-start)/seconds};
  });
}
