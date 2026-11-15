// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { createHash, randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { readArchive } from './archive';
import { applyFolderMapping, matchesFolderFile } from './folders';
import { applyUploadLanguage } from './languages';
import { ImportError, LIMITS, type Contest, type Gateway, type Job, type Row, type InputRow } from './types';
export const contestKey = (domain: string, id: string) => `${domain}:${id}`;
export class ImportService {
  readonly jobs; readonly rows; readonly claims; readonly audit;
  private busy = false;
  constructor(readonly db: Db, readonly gateway: Gateway) {
    this.jobs = db.collection<Job>('offline_judge_jobs');
    this.rows = db.collection<Row>('offline_judge_rows');
    this.claims = db.collection<{ _id: string; domainId: string; contestId: string; jobId: ObjectId; state: string; actor: number; createdAt: Date }>('offline_judge_contests');
    this.audit = db.collection('offline_judge_audit');
  }
  async init() {
    await this.jobs.createIndex({ domainId: 1, contestId: 1, createdAt: -1 });
    await this.rows.createIndex({ jobId: 1 });
    await this.jobs.createIndex({ actor: 1, state: 1, createdAt: -1 });
    await this.audit.createIndex({ domainId: 1, at: -1 });
  }
  private id(value: string) { if (!/^[a-f\d]{24}$/i.test(value)) throw new ImportError(400, '批次 ID 无效'); return new ObjectId(value); }
  private async permit(actor: number, domain: string, contestId?: string) {
    if (!await this.gateway.authorize(actor, domain, contestId)) throw new ImportError(403, '需要当前子域的比赛管理权限');
  }
  private async importable(contest: Contest) {
    const reason = await this.gateway.importBlock?.(contest);
    if (reason) throw new ImportError(409, reason);
    const claim = await this.claims.findOne({ _id: contestKey(contest.domainId, contest.id) });
    if (claim && (claim.state !== 'complete' || !this.gateway.replacement)) throw new ImportError(409, '原离线批次尚未完成，请先查看或继续原批次');
  }
  async competition(actor: number, domain: string, id: string) {
    await this.permit(actor, domain, id);
    const contest = await this.gateway.contest(domain, id);
    const claim = await this.claims.findOne({ _id: contestKey(domain, contest.id) });
    const reason = await this.gateway.importBlock?.(contest) || (claim && (claim.state !== 'complete' || !this.gateway.replacement) ? '原离线批次尚未完成，请先查看或继续原批次' : '');
    return { ...contest, importAllowed: !reason, importBlock: reason, formalBatch: claim ? { id: String(claim.jobId), state: claim.state } : null };
  }
  async preview(actor: number, domain: string, id: string, bytes: Uint8Array, mapping?: unknown, language?: unknown) {
    await this.permit(actor, domain, id);
    const contest = await this.gateway.contest(domain, id);
    await this.importable(contest);
    if (await this.jobs.countDocuments({ actor, state: 'preview', createdAt: { $gt: new Date(Date.now() - LIMITS.previewMs) } }) >= 5) throw new ImportError(429, '最多保留 5 个有效预览，请先取消不需要的批次');
    const archive = await readArchive(bytes);
    return this.createPreview(actor, domain, contest, archive, archive.ignoredFiles, mapping, language);
  }
  private async createPreview(actor:number,domain:string,contest:Contest,source:InputRow[],ignoredFiles:string[],mapping?:unknown,language?:unknown,preserveLanguage=false) {
    const id=contest.id;
    const candidates=source.filter(matchesFolderFile);
    if(!candidates.length)throw new ImportError(400,'未找到题目目录名与文件名完全一致的代码文件');
    ignoredFiles=[...new Set([...ignoredFiles,...source.filter(r=>!matchesFolderFile(r)&&r.file).map(r=>r.file)])];
    const mapped = applyFolderMapping(candidates,contest,mapping);
    const input = preserveLanguage ? mapped : applyUploadLanguage(mapped,language);
    const resolved = await this.gateway.resolve(contest, input);
    await this.gateway.participants?.(actor, domain, id, [...new Set(resolved.filter(r=>!r.excluded).map(r => r.uid).filter(uid=>uid>0))]);
    await this.importable(contest);
    const replacement = await this.gateway.replacement?.(contest, resolved);
    const now = new Date(), job: Job = {
      _id: new ObjectId(), domainId: domain, contestId: id, title: contest.title, actor,
      fingerprint: contest.fingerprint,
      digest: createHash('sha256').update(JSON.stringify(resolved.map(r => [r.uid, r.problem, r.file, r.language, r.hash, !!r.excluded]))).digest('hex'),
      state: 'preview', revision: 1, count: resolved.length, createdAt: now, updatedAt: now,
      expiresAt: new Date(now.getTime() + LIMITS.previewMs), error: '', ignoredFiles, ...(replacement ? { replacement } : {}),
    };
    await this.rows.insertMany(resolved.map((r, i) => ({ ...r, _id: `${job._id}:${i}`, jobId: job._id, domainId: domain, contestId: id, state: 'pending' as const })));
    try { await this.jobs.insertOne(job); } catch (e) { await this.rows.deleteMany({ jobId: job._id }); throw e; }
    return this.view(actor, domain, String(job._id));
  }
  async job(actor: number, domain: string, id: string) {
    await this.permit(actor, domain);
    const job = await this.jobs.findOne({ _id: this.id(id), domainId: domain });
    if (!job) throw new ImportError(404, '批次不存在');
    await this.permit(actor, domain, job.contestId);
    return job;
  }
  async view(actor: number, domain: string, id: string) {
    const job = await this.job(actor, domain, id);
    const stored = await this.rows.find({ jobId: job._id }).sort({ line: 1 }).toArray();
    const needsMatch=job.state==='preview'&&stored.some(r=>!matchesFolderFile(r));
    const rows=job.state==='preview'?stored.filter(matchesFolderFile):stored;
    const ignoredFiles=[...new Set([...(job.ignoredFiles??[]),...(needsMatch?stored.filter(r=>!matchesFolderFile(r)&&r.file).map(r=>r.file):[])])];
    const output = [];
    for (const r of rows) {
      const result = r.pid && r.state !== 'pending' ? await this.gateway.result(job, r) : null;
      output.push({ excluded:!!r.excluded, contestantName:r.contestantName,problemFolder:r.problemFolder,line: r.line, uid: r.uid, username: r.username, problem: r.problem, pid: r.pid, file: r.file, language: r.language, bytes: Buffer.byteLength(r.code), hash: r.hash, errors: r.errors, state: r.state, rid: r.pid && r.state !== 'pending' ? String(r.rid) : null, result });
    }
    const canResume = ['interrupted', 'attention'].includes(job.state) || (job.state === 'confirming' && Date.now() - job.updatedAt.getTime() >= 120_000) || (job.state === 'running' && !!job.heartbeat && Date.now() - job.heartbeat.getTime() >= 120_000);
    const targets = job.replacement?.targets.filter(t => t.records.length || t.journal.length) ?? [];
    const overwrite = { required: !!(targets.length || job.replacement?.previousJobId), records: targets.reduce((n, t) => n + t.records.length, 0), targets: targets.map(t => ({ uid: t.uid, pid: t.pid, score: t.score })), previousBatch: job.replacement?.previousJobId ?? null };
    const active = job.state === 'complete' ? await this.claims.findOne({ _id: contestKey(domain, job.contestId) }) : null;
    const superseded = !!active && String(active.jobId) !== String(job._id);
    return { canResume, overwrite, superseded, needsMatch, ignoredFiles, id: String(job._id), contestId: job.contestId, title: job.title, actor: job.actor, state: job.state, revision: job.revision, error: job.error, createdAt: job.createdAt, expiresAt: job.expiresAt, participants: new Set(rows.filter(r=>!r.excluded).map(r => r.uid)).size, rows: output };
  }
  async history(actor: number, domain: string, id: string) {
    await this.permit(actor, domain);
    if (!/^[a-f\d]{24}$/i.test(id)) throw new ImportError(400, '比赛 ID 无效');
    id = new ObjectId(id).toHexString();
    await this.permit(actor, domain, id);
    return (await this.jobs.find({ domainId: domain, contestId: id }).sort({ createdAt: -1 }).limit(30).toArray()).map(j => ({ id: String(j._id), state: j.state, count: j.count, createdAt: j.createdAt, actor: j.actor }));
  }
  async match(actor:number,domain:string,id:string,revision:number,mapping:unknown,language?:unknown) {
    const job=await this.job(actor,domain,id);
    if(job.actor!==actor)throw new ImportError(403,'只能调整自己的导入预览');
    if(job.state!=='preview'||job.revision!==revision||job.expiresAt<=new Date())throw new ImportError(409,'预览已变化或过期');
    const contest=await this.gateway.contest(domain,job.contestId);
    await this.importable(contest);
    if(contest.fingerprint!==job.fingerprint)throw new ImportError(409,'比赛配置已变化，请重新预览');
    const rows=await this.rows.find({jobId:job._id}).sort({line:1}).toArray();
    if(rows.length!==job.count)throw new ImportError(409,'预览明细不完整');
    const fresh=await this.createPreview(actor,domain,contest,rows,job.ignoredFiles??[],mapping,language,language===undefined);
    try { await this.cancel(actor,domain,id,revision); }
    catch(error) { await this.cancel(actor,domain,fresh.id,fresh.revision);throw error; }
    return fresh;
  }
  async confirm(actor: number, domain: string, id: string, revision: number, acknowledgeOverwrite = false) {
    await this.permit(actor, domain);
    const work = (verify = async () => {}) => this.confirmLocked(actor, domain, id, revision, acknowledgeOverwrite, verify);
    return this.gateway.withMutation ? this.gateway.withMutation(work) : work();
  }
  private async confirmLocked(actor: number, domain: string, id: string, revision: number, acknowledgeOverwrite: boolean, verify: () => Promise<void>) {
    const job = await this.job(actor, domain, id);
    if (!Number.isSafeInteger(revision) || job.revision !== revision || job.state !== 'preview') throw new ImportError(409, '预览状态已变化，请重新打开');
    if (job.expiresAt <= new Date()) throw new ImportError(409, '预览已过期，请重新上传');
    const contest = await this.gateway.contest(domain, job.contestId);
    await this.importable(contest);
    if (contest.fingerprint !== job.fingerprint) throw new ImportError(409, '比赛、题目或语言配置已变化，请重新预览');
    const rows = await this.rows.find({ jobId: job._id }).sort({ line: 1 }).toArray();
    if(rows.some(r=>!matchesFolderFile(r)))throw new ImportError(409,'请先应用文件选择与匹配');
    if (rows.length !== job.count || !rows.some(r=>!r.excluded) || rows.some(r => !r.excluded&&r.errors.length)) throw new ImportError(409, '预览存在错误，不能确认');
    await this.gateway.participants?.(actor, domain, job.contestId, [...new Set(rows.filter(r=>!r.excluded).map(r=>r.uid))]);
    const rechecked = await this.gateway.resolve(contest, rows);
    if (rechecked.some(r => !r.excluded&&r.errors.length)) throw new ImportError(409, '账号、成员关系或已有提交已变化，请重新预览');
    const fresh = await this.gateway.replacement?.(contest, rechecked);
    if (fresh && (!job.replacement || fresh.fingerprint !== job.replacement.fingerprint)) throw new ImportError(409, '既有提交、成绩或离线批次已变化，请重新预览');
    if (fresh && (fresh.previousJobId || fresh.targets.some(t => t.records.length || t.journal.length)) && acknowledgeOverwrite !== true) throw new ImportError(409, '请明确确认覆盖既有提交和成绩后再导入');
    await verify();
    const locked = await this.jobs.updateOne({ _id: job._id, state: 'preview', revision }, { $set: { state: 'confirming', updatedAt: new Date() }, $inc: { revision: 1 } });
    if (!locked.modifiedCount) throw new ImportError(409, '预览状态已变化');
    // Only one active batch can own a contest. A completed, unreviewed batch
    // can be replaced through an exact compare-and-swap, never during a run.
    try {
      const claim = { _id: contestKey(domain, job.contestId), domainId: domain, contestId: job.contestId, jobId: job._id, state: 'importing', actor, createdAt: new Date() };
      if (fresh?.previousJobId) {
        const changed = await this.claims.replaceOne({ _id: claim._id, jobId: new ObjectId(fresh.previousJobId), state: 'complete' }, claim);
        if (!changed.modifiedCount) throw Object.assign(new Error('Claim changed'), { code: 11000 });
      } else await this.claims.insertOne(claim);
    } catch (e: any) {
      if (e.code === 11000) {
        await this.jobs.updateOne({ _id: job._id, state: 'confirming' }, { $set: { state: 'cancelled', error: '比赛已有正式批次' }, $inc: { revision: 1 } });
        await this.rows.updateMany({ jobId: job._id }, { $set: { code: '' } });
        throw new ImportError(409, '正式批次已变化，请重新打开并预览');
      }
      throw e;
    }
    await this.audit.insertOne({ domainId: domain, contestId: job.contestId, jobId: job._id, actor, action: fresh?.previousJobId || fresh?.targets.some(t => t.records.length || t.journal.length) ? 'confirm-overwrite' : 'confirm', at: new Date(), digest: job.digest, rows: job.count, previousJobId: fresh?.previousJobId ?? null });
    await this.jobs.updateOne({ _id: job._id, state: 'confirming' }, { $set: { state: 'queued', actor, updatedAt: new Date() }, $inc: { revision: 1 } });
    return this.view(actor, domain, id);
  }
  async cancel(actor: number, domain: string, id: string, revision: number) {
    const job = await this.job(actor, domain, id);
    if (await this.claims.findOne({ jobId: job._id })) throw new ImportError(409, '正式批次不能取消或重新上传');
    const result = await this.jobs.updateOne({ _id: job._id, state: 'preview', revision }, { $set: { state: 'cancelled', updatedAt: new Date() }, $inc: { revision: 1 } });
    if (!result.modifiedCount) throw new ImportError(409, '批次已变化');
    await this.rows.updateMany({ jobId: job._id }, { $set: { code: '' } });
    return this.view(actor, domain, id);
  }
  async resume(actor: number, domain: string, id: string, revision: number) {
    const job = await this.job(actor, domain, id);
    const claim = await this.claims.findOne({ jobId: job._id });
    if (!claim) throw new ImportError(409, '批次尚未确认');
    if (job.revision !== revision) throw new ImportError(409, '批次已变化，请刷新');
    if (job.state === 'confirming' && Date.now() - job.updatedAt.getTime() < 120_000) throw new ImportError(409, '批次仍在确认');
    if (job.state === 'running' && job.heartbeat && Date.now() - job.heartbeat.getTime() < 120_000) throw new ImportError(409, '批次仍在运行');
    if (!['preview', 'confirming', 'running', 'interrupted', 'attention'].includes(job.state)) throw new ImportError(409, '当前状态不能继续');
    const changed = await this.jobs.updateOne({ _id: job._id, revision, state: job.state, token: job.token }, { $set: { state: 'queued', actor, updatedAt: new Date() }, $unset: { token: '' }, $inc: { revision: 1 } });
    if (!changed.modifiedCount) throw new ImportError(409, '批次已变化');
    return this.view(actor, domain, id);
  }
  private async checkpoint(job: Job, token: string): Promise<Contest> {
    if (!await this.gateway.authorize(job.actor, job.domainId, job.contestId)) throw new ImportError(403, '操作人的比赛管理权限已失效');
    await this.gateway.participants?.(job.actor, job.domainId, job.contestId, (await this.rows.find({jobId:job._id,excluded:{$ne:true}}).project({uid:1}).toArray()).map(r=>r.uid));
    const contest = await this.gateway.contest(job.domainId, job.contestId);
    const reason = await this.gateway.importBlock?.(contest);
    if (reason) throw new ImportError(409, reason);
    if (!await this.claims.findOne({ _id: contestKey(job.domainId, job.contestId), jobId: job._id, state: 'importing' })) throw new ImportError(409, '批次已被替换，不能继续执行');
    if (contest.fingerprint !== job.fingerprint) throw new ImportError(409, '比赛配置变化，批次已暂停');
    const lock = await this.jobs.updateOne({ _id: job._id, state: 'running', token }, { $set: { heartbeat: new Date(), updatedAt: new Date() } });
    if (!lock.matchedCount) throw new ImportError(409, '运行权已变化');
    return contest;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Expire only unconfirmed previews; accepted jobs must remain resumable.
      const expired = await this.jobs.find({ state: 'preview', expiresAt: { $lt: new Date() } }).limit(10).toArray();
      for (const j of expired) if (!await this.claims.findOne({ jobId: j._id })) {
        const change = await this.jobs.updateOne({ _id: j._id, state: 'preview' }, { $set: { state: 'expired' }, $inc: { revision: 1 } });
        if (change.modifiedCount) await this.rows.updateMany({ jobId: j._id }, { $set: { code: '' } });
      }
      const token = randomUUID();
      const job = await this.jobs.findOneAndUpdate({ state: 'queued' }, { $set: { state: 'running', token, heartbeat: new Date(), updatedAt: new Date(), error: '' }, $inc: { revision: 1 } }, { sort: { createdAt: 1 }, returnDocument: 'after' });
      if (job) await this.execute(job, token);
      const judging = await this.jobs.find({ state: 'judging' }).limit(5).toArray();
      for (const j of judging) {
        const rows = await this.rows.find({ jobId: j._id }).toArray();
        let complete = rows.length === j.count;
        for (const r of rows) if (!r.excluded && r.pid && !(await this.gateway.result(j, r)).terminal) { complete = false; break; }
        if (complete) {
          await this.jobs.updateOne({ _id: j._id, state: 'judging' }, { $set: { state: 'complete', updatedAt: new Date() }, $inc: { revision: 1 } });
          await this.claims.updateOne({ jobId: j._id }, { $set: { state: 'complete' } });
          await this.rows.updateMany({ jobId: j._id }, { $set: { code: '' } });
        }
      }
    } finally { this.busy = false; }
  }
  private async execute(job: Job, token: string) {
    try {
      const rows = await this.rows.find({ jobId: job._id }).sort({ line: 1 }).toArray();
      if (rows.length !== job.count) throw new ImportError(409, '批次明细不完整，已停止');
      // Register every participant and every official record before dispatching.
      for (const row of rows) if (!row.excluded && row.state === 'pending') {
        const contest = await this.checkpoint(job, token);
        const checked = await this.gateway.resolve(contest, [row], String(job._id));
        if (checked[0].errors.length) throw new ImportError(409, checked[0].errors.join('；'));
        await this.gateway.register(job, row);
        await this.rows.updateOne({ _id: row._id, state: 'pending' }, { $set: { state: 'registered' } });
        row.state = 'registered';
      }
      for (const row of rows) {
        if(row.excluded)continue;
        await this.checkpoint(job, token);
        if (!row.pid) { await this.rows.updateOne({ _id: row._id }, { $set: { state: 'queued' } }); continue; }
        if (row.state === 'queued') continue;
        if (row.state === 'dispatching') {
          const result = await this.gateway.result(job, row);
          if (!result.queued && (result.status === 0 || result.status === null)) throw new ImportError(409, `第 ${row.line} 行投递状态不确定，请管理员核对任务和评测记录；不会自动重复投递`);
        } else {
          const claimed = await this.rows.updateOne({ _id: row._id, state: 'registered' }, { $set: { state: 'dispatching' } });
          if (!claimed.modifiedCount) throw new ImportError(409, '任务投递状态已变化，请刷新检查');
          await this.gateway.dispatch(job, row);
        }
        await this.rows.updateOne({ _id: row._id }, { $set: { state: 'queued' } });
        // Bound new queue pressure to roughly five submissions/second.
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await this.jobs.updateOne({ _id: job._id, state: 'running', token }, { $set: { state: 'judging', updatedAt: new Date() }, $inc: { revision: 1 } });
      await this.audit.insertOne({ domainId: job.domainId, contestId: job.contestId, jobId: job._id, actor: job.actor, action: 'dispatched', at: new Date() });
    } catch (e) {
      const state = e instanceof ImportError ? 'attention' : 'interrupted';
      await this.jobs.updateOne({ _id: job._id, state: 'running', token }, { $set: { state, error: e instanceof ImportError ? e.message : '导入中断，请检查服务日志并从原批次继续', updatedAt: new Date() }, $inc: { revision: 1 } });
    }
  }
}
