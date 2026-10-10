import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PUMP_PROGRAM, CREATE_DISCRIMINATOR, decodeCreateData, encodeBase58, parsePumpLogNotification } from '../src/decoder.mjs';
import { normalizeMetadataUrl, extractXHandle, bioMintStatus, getMetadata, getXProfile } from '../src/enrich.mjs';
import { Radar } from '../src/radar.mjs';

const mintBytes = Buffer.alloc(32, 4);
const mint = encodeBase58(mintBytes);
function str(value) {
 const bytes=Buffer.from(value),len=Buffer.alloc(4);len.writeUInt32LE(bytes.length);
 return Buffer.concat([len,bytes]);
}
const create=Buffer.concat([
 Buffer.from(CREATE_DISCRIMINATOR,'hex'),str('Sample Token'),str('SMPL'),
 str('ipfs://bafyexample'),mintBytes,Buffer.from([1])
]).toString('base64');

test('reads CreateEvent even with an opaque compatibility tail',()=>{
 assert.deepEqual(decodeCreateData(create),{
   name:'Sample Token',symbol:'SMPL',uri:'ipfs://bafyexample',mint
 });
 assert.equal(decodeCreateData('not-base64'),null);
 assert.equal(decodeCreateData(Buffer.from('random').toString('base64')),null);
});
test('requires a successful transaction and Pump stack scope',()=>{
 const foreign='FnRee11111111111111111111111111111111111111';
 const message={method:'logsNotification',params:{subscription:5,result:{
  context:{slot:123},value:{err:null,signature:'fakeSig',logs:[
   'Program '+PUMP_PROGRAM+' invoke [1]',
   'Program '+foreign+' invoke [2]',
   'Program data: '+create,
   'Program '+foreign+' success',
   'Program data: '+create,
   'Program '+PUMP_PROGRAM+' success'
  ]}
 }}};
 assert.equal(parsePumpLogNotification(message,5).length,1);
 assert.equal(parsePumpLogNotification(message,6).length,0);
 message.params.result.value.err={InstructionError:[0,'Something']};
 assert.equal(parsePumpLogNotification(message,5).length,0);
});
test('metadata host allowlist and redirect safety',async()=>{
 assert.equal(normalizeMetadataUrl('ipfs://bafyabc'),'https://ipfs.io/ipfs/bafyabc');
 assert.equal(normalizeMetadataUrl('https://127.0.0.1/private'),null);
 assert.equal(normalizeMetadataUrl('http://ipfs.io/x'),null);
 assert.equal(normalizeMetadataUrl('https://evil.example/x'),null);
 assert.equal(normalizeMetadataUrl('https://pump.mypinata.cloud/ipfs/x'),'https://pump.mypinata.cloud/ipfs/x');
 const meta=await getMetadata('ipfs://bafyabc',{fetchFn:async()=>new Response(JSON.stringify({twitter:'https://x.com/green'}))});
 assert.equal(extractXHandle(meta),'green');
 await assert.rejects(getMetadata('ipfs://bafyabc',{fetchFn:async()=>new Response(null,{
   status:302,headers:{location:'http://localhost/admin'}
 })}),/METADATA_REDIRECT_BLOCKED/);
});
test('factual X link extraction rejects social posts and impostor hosts',()=>{
 assert.equal(extractXHandle({twitter:'https://x.com/good_handle'}),'good_handle');
 assert.equal(extractXHandle({socials:{x:'@good_handle'}}),'good_handle');
 assert.equal(extractXHandle({twitter:'https://x.com/real/status/123'}),null);
 assert.equal(extractXHandle({twitter:'https://x.com.evil.example/user'}),null);
});
test('structured X identity validation, followers and exact mint in bio',async()=>{
 const good=await getXProfile('green','test-token',{fetchFn:async()=>new Response(JSON.stringify({
  data:{id:'23',username:'Green',description:'mint '+mint,public_metrics:{followers_count:108001}}
 }))});
 assert.equal(good.status,'OBSERVED');
 assert.equal(good.followers,108001);
 assert.equal(bioMintStatus(good.description,mint),'BIO_MENTIONS_MINT');
 assert.equal(bioMintStatus('no matching token',mint),'NOT_FOUND_IN_BIO');
 const invalid=await getXProfile('green','test-token',{fetchFn:async()=>new Response(JSON.stringify({
  data:{id:'23',username:'another',public_metrics:{followers_count:80000}}
 }))});
 assert.equal(invalid.status,'INVALID_RESPONSE');
});
test('flags purely on followers without buyer evidence or mint confirmation',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'social-radar-test-'));
 try{
  const radar=new Radar({
   token:'unit-test',threshold:10000,dataFile:path.join(dir,'alerts.jsonl'),
   metadataFetcher:async()=>({twitter:'https://x.com/green'}),
   profileFetcher:async()=>({status:'OBSERVED',username:'green',userId:'24',
     followers:54321,description:'',collectedAtMs:Date.now()})
  });
  await radar.processLaunch({mint,name:'Sample',symbol:'SMPL',uri:'ipfs://x',firstObservedAtMs:Date.now()});
  assert.equal(radar.alerts.length,1);
  assert.equal(radar.alerts[0].addressEvidence,'NOT_FOUND_IN_BIO');
  assert.equal(radar.alerts[0].accountOwnershipVerified,false);
  assert.equal(JSON.parse((await readFile(radar.dataFile,'utf8')).trim()).followers,54321);
 }finally{await rm(dir,{force:true,recursive:true});}
});
test('paid X lookups are paced',()=>{
 const radar=new Radar({lookupsPer15m:15});
 const at=Date.now();
 assert.equal(radar.reserveXLookup(at),true);
 assert.equal(radar.reserveXLookup(at+1000),false);
 assert.equal(radar.reserveXLookup(at+60000),true);
 assert.equal(radar.metrics.xLookups,2);
});
