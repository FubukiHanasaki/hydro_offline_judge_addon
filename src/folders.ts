// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { ImportError, type Contest, type InputRow } from './types';
export function applyFolderMapping(rows: InputRow[], contest: Contest, value: unknown): InputRow[] {
  if (value === undefined) return rows;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['people','problems'].includes(k))) throw new ImportError(400,'匹配设置无效');
  const data=value as Record<string,unknown>,people=data.people??{},problems=data.problems??{};
  for(const group of [people,problems])if(!group||typeof group!=='object'||Array.isArray(group)||Object.keys(group).length>500)throw new ImportError(400,'匹配设置无效');
  const names=new Set(rows.map(r=>r.contestantName)),folders=new Set(rows.map(r=>r.problemFolder));
  for(const [key,v]of Object.entries(people))if(!names.has(key)||!Number.isSafeInteger(v)||(v as number)<=0)throw new ImportError(400,'选手匹配需要有效 UID');
  for(const [key,v]of Object.entries(problems))if(!folders.has(key)||!Number.isSafeInteger(v)||!contest.pids.includes(v as number))throw new ImportError(400,'题目匹配超出当前比赛');
  return rows.map(row=>({...row,...row.contestantName&&Object.hasOwn(people,row.contestantName)?{uid:(people as Record<string,number>)[row.contestantName],manualUid:true}:{},...row.problemFolder&&Object.hasOwn(problems,row.problemFolder)?{problem:String((problems as Record<string,number>)[row.problemFolder]),manualProblem:true}:{}}));
}
