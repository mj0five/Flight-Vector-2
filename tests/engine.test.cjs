const assert = require('node:assert/strict');
const { analyzeCsvText, bodyToNavigation } = require('../engine.js');
function fixture(moving=false, attitude=true) {
  const rows=['acc_1G,2048','time,accSmooth[0],accSmooth[1],accSmooth[2]' + (attitude?',heading[0],heading[1],heading[2]':'')];
  for(let i=0;i<=500;i++) rows.push([i*10000,moving && i>=300?2048/9.80665:0,0,2048,...(attitude?[0,0,0]:[])].join(','));
  return rows.join('\n');
}
const stationary=analyzeCsvText(fixture());
assert.ok(Math.abs(stationary.metrics.samplePeakKmh)<1e-9);
const moving=analyzeCsvText(fixture(true));
assert.ok(Math.abs(moving.metrics.samplePeakKmh-2.005*3.6)<1e-8);
const blocked=analyzeCsvText(fixture(false,false));
assert.equal(blocked.coverage.attitude,false);
assert.ok(Number.isNaN(blocked.metrics.samplePeakKmh));
assert.throws(()=>analyzeCsvText('time,accX\n0,0\n1,0\n2,0'));
const rotated=bodyToNavigation(1,0,0,0,0,Math.PI/2);
assert.ok(Math.abs(rotated[0])<1e-12 && Math.abs(rotated[1]-1)<1e-12);
assert.deepEqual(analyzeCsvText(fixture(true)).uncertainty.monteCarlo,moving.uncertainty.monteCarlo);
console.log('PASS: stationary, known acceleration, missing attitude, missing axes, rotation, deterministic sensitivity. Synthetic checks only; no flight validation.');
