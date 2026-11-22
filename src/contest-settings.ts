// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { ObjectId, type Db } from 'mongodb';
import { ImportError } from './types';
export interface ProblemSetting { name: string; io: 'inherit' | 'stdio' | 'file'; filename: string }
export interface ContestSettings { _id: string; version: number; problems: Record<string, ProblemSetting>; ioLocked?: boolean }
const english = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export function parseSettings(value: unknown, pids: number[]): Record<string, ProblemSetting> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw new ImportError(400,'题目对应设置无效');
 const out:Record<string,ProblemSetting>={},seen=new Set<string>();
 for(const [key,v] of Object.entries(value)){
  if(!pids.includes(Number(key))||String(Number(key))!==key||!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['name','io','filename'].includes(k)))throw new ImportError(400,'题目对应设置超出当前比赛');
  const b=v as Record<string,unknown>;
  if(typeof b.name!=='string'||typeof b.filename!=='string'||!['inherit','stdio','file'].includes(String(b.io)))throw new ImportError(400,'题目对应设置无效');
  const name=b.name.trim(),filename=b.filename.trim();
  if(name&&!english.test(name)||b.io==='file'&&!english.test(filename))throw new ImportError(400,'英文名和文件名须为字母开头的 1–64 位字母、数字、下划线或连字符，不含扩展名');
  if(name&&seen.has(name.toLowerCase()))throw new ImportError(400,'同场比赛的题目英文名不能重复');
  if(name)seen.add(name.toLowerCase());
  if(name||b.io!=='inherit')out[key]={name,io:b.io as ProblemSetting['io'],filename:b.io==='file'?filename:''};
 }
 return Object.fromEntries(Object.entries(out).sort(([a],[b])=>Number(a)-Number(b)));
}
function ioConfig(problems:Record<string,ProblemSetting>){return JSON.stringify(Object.fromEntries(Object.entries(problems).filter(([,v])=>v.io!=='inherit').map(([k,v])=>[k,[v.io,v.filename]])));}
export class SettingsStore {
 constructor(readonly db:Db){}
 get collection(){return this.db.collection<ContestSettings>('offline_judge_settings');}
 async read(domain:string,id:string){return await this.collection.findOne({_id:`${domain}:${id}`})??{_id:`${domain}:${id}`,version:0,problems:{}};}
 async save(actor:number,domain:string,id:string,pids:number[],version:unknown,value:unknown){
  if(!Number.isSafeInteger(version)||(version as number)<0)throw new ImportError(400,'设置版本无效');
  const problems=parseSettings(value,pids),old=await this.read(domain,id),ioChanged=ioConfig(old.problems)!==ioConfig(problems);
  if(old.version!==version)throw new ImportError(409,'题目设置已更新，请刷新页面');
  // Historical records without an IO snapshot must retain their original IO.
  const records=ioChanged&&await this.db.collection('record').findOne({domainId:domain,$or:[{contest:new ObjectId(id)},{'smsCorrection.contestId':id},{'offlineCorrection.contestId':id},{'offlineIo.contestId':id}]},{projection:{_id:1}});
  if(ioChanged&&(old.ioLocked||records))throw new ImportError(409,'已有提交的比赛不能修改 IO 设置；题目英文名仍可调整');
  const filter:any={_id:old._id,version:version===0?{$in:[0,null]}:version,...ioChanged?{ioLocked:{$ne:true}}:{}};
  try{
   const result=await this.collection.updateOne(filter,{$set:{problems,updatedBy:actor,updatedAt:new Date()},$inc:{version:1}},{upsert:version===0});
   if(!result.matchedCount&&!result.upsertedCount)throw new ImportError(409,'题目设置已变化，请刷新页面');
  }catch(e:any){if(e.code===11000)throw new ImportError(409,'题目设置已变化或已有提交，请刷新页面');throw e;}
  await this.db.collection('offline_judge_audit').insertOne({domainId:domain,contestId:id,actor,action:'settings.save',version:(version as number)+1,ioChanged,at:new Date()});
  return this.read(domain,id);
 }
 async freeze(domain:string,id:string){
  // Atomic with settings saves: a first submission freezes IO before it is queued.
  try{return await this.collection.findOneAndUpdate({_id:`${domain}:${id}`},{$set:{ioLocked:true},$setOnInsert:{version:0,problems:{}}},{upsert:true,returnDocument:'after'});}catch(e:any){if(e.code!==11000)throw e;return this.collection.findOneAndUpdate({_id:`${domain}:${id}`},{$set:{ioLocked:true}},{returnDocument:'after'});}
 }
}
