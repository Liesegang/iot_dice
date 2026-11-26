import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {loadCore} from '../tools/load-core.mjs';
const c=await loadCore();after(()=>c.cleanup());
const sample=(t,state='moving',v={x:1,y:-2,z:.5},w={x:1,y:0,z:0},a={x:0,y:0,z:0})=>({t,state,v,w,a});
function start(trail,t=0) {trail.add(sample(t));trail.add(sample((t+20)>>>0));}
test('relative trail preserves signed motion but clears immediately at REST',()=>{
 const trail=new c.trajectory.MotionTrail();start(trail);trail.add(sample(120));
 assert.deepEqual(trail.position,{x:.1,y:-.2,z:.05});
 trail.add(sample(130,'rest'));assert.equal(trail.points.length,0);
 start(trail,140);assert.deepEqual(trail.position,{x:0,y:0,z:0});
});
test('small stationary noise and stale firmware velocity never create a trail',()=>{
 const trail=new c.trajectory.MotionTrail();
 for(let t=0;t<5000;t+=10) trail.add(sample(t,'moving',{x:2,y:0,z:1},{x:.18,y:.1,z:0},{x:.3,y:.2,z:.1}));
 assert.equal(trail.points.length,0);
 start(trail,5010);trail.add(sample(5050));assert.ok(trail.points.length>0);
 for(let t=5060;t<=5260;t+=10) trail.add(sample(t,'tumbling',{x:3,y:0,z:0},{x:.18,y:0,z:0},{x:.2,y:0,z:0}));
 assert.equal(trail.points.length,0);assert.equal(trail.position.x,0);
});
test('duplicates, gaps and uptime wrap cannot create false long segments',()=>{
 const trail=new c.trajectory.MotionTrail();start(trail,0xfffffff0);trail.add(sample(104));
 assert.ok(Math.abs(trail.position.x-.1)<1e-10);
 trail.add(sample(104));assert.equal(trail.points.length,2);
 trail.add(sample(1004));trail.add(sample(1104));assert.equal(trail.points.length,0);
 trail.add(sample(1204,'rest'));start(trail,1304);assert.equal(trail.position.x,0);
 trail.add(sample(1404,'moving',{x:NaN,y:0,z:0}));assert.equal(trail.points.length,1);
});
