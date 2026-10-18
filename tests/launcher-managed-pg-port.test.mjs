import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import * as launcher from "../launcher/realm-launcher.mjs";

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(), "realm-managed-pg-port-"));
  const data=resolve(home,"postgres","data");mkdirSync(data,{recursive:true});
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const pid=(directory=data,port="55432")=>writeFileSync(join(data,"postmaster.pid"),["12345",directory,"0",port,"","127.0.0.1","0","ready"].join("\n")+"\n");
  return {home,data,pid};
}

test("restart resolves the already-running owned cluster port rather than selecting a free alternative",(t)=>{
  const f=fixture(t);f.pid();
  assert.equal(typeof launcher.resolveRunningPostgresPort,"function","launcher must resolve a live managed cluster's recorded port before free-port selection");
  const calls=[];
  const port=launcher.resolveRunningPostgresPort({dataHome:f.home,pgBin:resolve(f.home,"bin"),spawnSyncImpl:(command,args)=>{calls.push({command,args});return {status:0};}});
  assert.equal(port,55432);assert.equal(calls.length,1);assert.deepEqual(calls[0].args,["status","-D",f.data]);
});

test("stopped or absent managed clusters retain normal free-port selection",(t)=>{
  const f=fixture(t);
  assert.equal(typeof launcher.resolveRunningPostgresPort,"function");
  assert.equal(launcher.resolveRunningPostgresPort({dataHome:f.home,pgBin:f.home,spawnSyncImpl:()=>{throw Error("absent pid must not probe");}}),null);
  f.pid();assert.equal(launcher.resolveRunningPostgresPort({dataHome:f.home,pgBin:f.home,spawnSyncImpl:()=>({status:3})}),null);
});

test("foreign data paths and invalid PID ports cannot redirect managed-cluster reuse",(t)=>{
  const f=fixture(t);
  assert.equal(typeof launcher.resolveRunningPostgresPort,"function");
  let probeCalls=0;const probe=()=>{probeCalls+=1;return {status:0};};
  f.pid(resolve(f.home,"foreign"));assert.equal(launcher.resolveRunningPostgresPort({dataHome:f.home,pgBin:f.home,spawnSyncImpl:probe}),null);
  f.pid(f.data,"70000");assert.equal(launcher.resolveRunningPostgresPort({dataHome:f.home,pgBin:f.home,spawnSyncImpl:probe}),null);
  assert.equal(probeCalls,0);
});
