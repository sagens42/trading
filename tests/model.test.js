const M = require('../web/model.js');
const assert = require('assert');
// GBM with known vol: V1 probabilities should match lognormal.
let seed=1; const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const g=()=>Math.sqrt(-2*Math.log(rand()||1e-12))*Math.cos(2*Math.PI*rand());
const sd=0.03, c=[]; let p=100;
for(let i=0;i<20000;i++){const o=p; p*=Math.exp(-0.5*sd*sd+sd*g()); c.push({t:i*M.DAY,o,h:Math.max(o,p),l:Math.min(o,p),c:p});}
const n=30, s=M.buildSamples(c,n,{demean:true});
const T=n/365, vol=s.annualVol;
console.log('annualVol', s.annualVol.toFixed(4), 'expected', vol.toFixed(4));
for (const K of [80,100,120]) {
  const e=M.evaluate(s,100,K);
  const mkt=M.impliedProbAbove(100,K,T,vol), bs=M.black76(100,K,T,vol,true);
  console.log(K, 'pAbove', e.pAbove.toFixed(3), 'vs', mkt.toFixed(3), '| call', e.callFair.toFixed(2), 'vs', bs.toFixed(2), '| touch', e.pTouch.toFixed(3));
  assert(Math.abs(e.pAbove-mkt)<0.03); assert(Math.abs(e.callFair-bs)/bs<0.08);
  assert(e.pTouch>=Math.min(e.pAbove,1-e.pAbove)-1e-9);
}
// put-call parity on the sample distribution: C - P = E[S]-K
const e=M.evaluate(s,100,105); const ES=s.r.reduce((a,r)=>a+100*Math.exp(r),0)/s.count;
assert(Math.abs((e.callFair-e.putFair)-(ES-105))<1e-6);
// Vol scaling: target doubles vol -> annualVol doubles (no mean reversion when then==now)
const vArr=new Float64Array(c.length).fill(sd);
const s2=M.buildSamples(c,n,{targetVol:2*sd,volArr:vArr,volLR:sd,demean:true});
const em=s2.r.reduce((a,r)=>a+Math.exp(r),0)/s2.count;
console.log('scaled vol', s2.annualVol.toFixed(4), 'E[exp r]', em.toFixed(9));
assert(Math.abs(s2.annualVol/s.annualVol-2)<1e-6); assert(Math.abs(em-1)<1e-9);
// martingale -> put-call parity C-P = S0-K exactly
const e3=M.evaluate(s2,100,110); assert(Math.abs((e3.callFair-e3.putFair)-(100-110))<1e-6);
// survival curve agrees with evaluate
const xs=[90,100,110]; const sc=M.survivalCurve(s,100,xs);
xs.forEach((x,i)=>assert(Math.abs(sc[i]-M.evaluate(s,100,x).pAbove)<1e-9));
// horizonVol limits
assert(Math.abs(M.horizonVol(0.05,0.03,0.001)-0.05)<1e-4); assert(Math.abs(M.horizonVol(0.05,0.03,1e5)-0.03)<1e-3);
console.log('ok');
