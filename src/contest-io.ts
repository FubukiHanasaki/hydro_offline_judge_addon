// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ObjectId, type Db } from 'mongodb';
import { Context, ContestModel, RecordModel } from 'hydrooj';
import { SettingsStore } from './contest-settings';
export function installContestIo(ctx:Context,db:Db){
 const scope=new AsyncLocalStorage<{domain:string;contestId:string;pid:number;uid:number}>(),store=new SettingsStore(db);
 for(const name of ['ProblemDetail','ProblemSubmit'])ctx.on(`handler/after/${name}`,async(h:any)=>{
  if(h.context.method!=='GET'||h.tdoc?.rule!=='oi'||!h.response.body?.pdoc)return;
  const setting=(await store.read(h.domain._id,String(h.tdoc.docId))).problems[String(h.pdoc?.docId)];
  if(!setting||setting.io==='inherit')return;
  const pdoc=h.response.body.pdoc,filename=setting.io==='file'?setting.filename:'';
  h.response.body.pdoc={...pdoc,config:{...pdoc.config,filename,subType:filename}};
  h.response.addHeader('Cache-Control','private, no-store');
 });
 ctx.on('handler/before/ProblemSubmit',async(h:any)=>{
  const id=String(h.tdoc?.docId??'');
  if(h.context.method!=='POST'||h.tdoc?.rule!=='oi'||!ObjectId.isValid(id)||!h.tdoc.pids?.includes(h.pdoc?.docId))return;
  const original=h.post.bind(h),local={domain:h.domain._id,contestId:id,pid:h.pdoc.docId,uid:h.user._id};
  h.post=(...args:any[])=>scope.run(local,()=>original(...args));
 });
 ctx.effect(()=>{
  const original=RecordModel.judge;
  const wrapped=async function(domain:string,rids:any,priority=0,config:any={},meta:any={}){
   // Hydro and addons may load different MongoDB driver copies.
   const values=Array.isArray(rids)?rids:[rids?._id??rids];
   const ids=values.map(id=>ObjectId.isValid(String(id))?new ObjectId(String(id)):id);
   const records=await RecordModel.coll.find({domainId:domain,_id:{$in:ids}}).toArray();
   const results:Record<number,unknown>={};let count=0;
   for(const record of records){
    const local=scope.getStore();
    const fromContext=local?.domain===domain&&local.pid===record.pid&&local.uid===record.uid;
    const id=String(record.offlineIo?.contestId??record.contest??record.smsCorrection?.contestId??record.offlineCorrection?.contestId??(fromContext?local.contestId:''));
    let override:any={};
    if(record.offlineIo&&/^[a-f\d]{24}$/i.test(id)&&typeof record.offlineIo.filename==='string'&&/^(?:[A-Za-z][A-Za-z0-9_-]{0,63})?$/.test(record.offlineIo.filename))override={filename:record.offlineIo.filename};
    else if(/^[a-f\d]{24}$/i.test(id)&&!id.startsWith('0'.repeat(23))){
     const contest=await ContestModel.get(domain,new ObjectId(id));
     if(contest?.rule==='oi'&&contest.pids?.includes(record.pid)){
      const settings=await store.freeze(domain,id),setting=settings?.problems[String(record.pid)];
      // Snapshot is internal, never sourced from request fields; it also follows corrections on rejudge.
      const filename=record.offlineIo?record.offlineIo.filename:setting?.io==='file'?setting.filename:setting?.io==='stdio'?'':undefined;
      if(filename!==undefined){
       override={filename};
       if(!record.offlineIo)await RecordModel.coll.updateOne({_id:record._id,domainId:domain},{$set:{offlineIo:{contestId:id,filename}}});
      }
     }
    }
    const dispatched=await original.call(RecordModel,domain,record,priority,{...config,...override},meta);
    for(const task of Object.values(dispatched??{}))results[count++]=task;
   }
   return records.length?results:null;
  };
  RecordModel.judge=wrapped;
  return()=>{if(RecordModel.judge===wrapped)RecordModel.judge=original;};
 });
}
