// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { createHash, randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { ImportError, type Contest, type Job, type Row, type ResolvedRow, type ReplacementPlan } from './types';

const terminal = [1, 2, 3, 4, 5, 6, 7, 11];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ReplacementGuard {
  constructor(readonly db: Db) {}
  async reviewed(domain: string, id: string): Promise<boolean> {
    const head = await this.db.collection('sms_rating_head').findOne({ _id: 'global' as any });
    return !!(await this.db.collection('sms_rating_reviews').findOne({ domainId: domain, contestId: id, state: { $in: ['confirming', 'complete'] } })
      || await this.db.collection('sms_audit').findOne({ action: 'rating.review', target: `${domain}:${id}` })
      || head && await this.db.collection('sms_rating_sources').findOne({ generation: head.generation, key: `contest:${domain}:${id}` }));
  }
  // Use the same lease as SMS Rating publication, so a review cannot publish
  // between the final check and the atomic change of the active import claim.
  async locked<T>(work: (verify: () => Promise<void>) => Promise<T>): Promise<T> {
    const heads = this.db.collection('sms_rating_head'), head = await heads.findOne({ _id: 'global' as any });
    if (!head) return work(async () => {});
    const token = randomUUID(), now = new Date();
    const lock = await heads.findOneAndUpdate({ _id: head._id, revision: head.revision,
      $or: [{ lock: { $exists: false } }, { lockUntil: { $lt: now } }] },
    { $set: { lock: token, lockUntil: new Date(+now + 600000) } }, { returnDocument: 'after' });
    if (!lock) throw new ImportError(409, 'Rating 正在更新，请稍后重新确认导入');
    const verify = async () => {
      const now = new Date();
      const renewed = await heads.updateOne({ _id: head._id, lock: token, lockUntil: { $gt: now } }, { $set: { lockUntil: new Date(+now + 600000) } });
      if (!renewed.matchedCount) throw new ImportError(409, '确认超时或 Rating 锁已变化，请重新预览');
    };
    try { return await work(verify); }
    finally { await heads.updateOne({ _id: head._id, lock: token }, { $unset: { lock: '', lockUntil: '' } }); }
  }
  async plan(c: Contest, rows: ResolvedRow[]): Promise<ReplacementPlan> {
    const claim = await this.db.collection('offline_judge_contests').findOne({ _id: `${c.domainId}:${c.id}` as any });
    if (claim && claim.state !== 'complete') throw new ImportError(409, '原离线批次尚未完成，请先查看或继续原批次');
    const targets = [];
    const pairs = [...new Set(rows.filter(r => !r.excluded && r.uid > 0 && r.pid > 0).map(r => `${r.uid}:${r.pid}`))].sort();
    for (const pair of pairs) {
      const [uid, pid] = pair.split(':').map(Number);
      const records = await this.db.collection('record').find({ domainId: c.domainId, contest: new ObjectId(c.id), uid, pid },
        { projection: { _id: 1, status: 1, score: 1 } }).sort({ _id: 1 }).toArray();
      if (records.some(r => !terminal.includes(r.status)) || await this.db.collection('task').findOne({ domainId: c.domainId, rid: { $in: records.map(r => r._id) } }))
        throw new ImportError(409, `UID ${uid} 的题目 ${pid} 仍在评测或需要重测，请处理完成后再覆盖`);
      const status = await this.db.collection('document.status').findOne({ domainId: c.domainId, docType: 30, docId: new ObjectId(c.id), uid });
      const journal = (status?.journal ?? []).filter((j: any) => j.pid === pid).sort((a: any, b: any) => String(a.rid).localeCompare(String(b.rid)));
      targets.push({ uid, pid, records: records.map(r => ({ id: String(r._id), status: r.status, score: r.score })), journal, score: status?.detail?.[pid]?.score ?? null });
    }
    const previousJobId = claim ? String(claim.jobId) : null;
    return { previousJobId, targets, fingerprint: digest([previousJobId, targets]) };
  }
  async apply(job: Job, row: Row) {
    const target = job.replacement?.targets.find(t => t.uid === row.uid && t.pid === row.pid);
    if (!target) return;
    const tid = new ObjectId(job.contestId), marker = { contestId: job.contestId, jobId: String(job._id), at: new Date() };
    const formal = await this.db.collection('record').find({ domainId: job.domainId, contest: tid, uid: row.uid, pid: row.pid, 'offlineImport.jobId': { $ne: String(job._id) } }, { projection: { _id: 1, status: 1, score: 1 } }).toArray();
    if (formal.some(r => !target.records.some(old => old.id === String(r._id) && old.status === r.status && old.score === r.score))) throw new ImportError(409, '正式提交与覆盖预览不一致，已暂停覆盖');
    const current = await this.db.collection('document.status').findOne({ domainId: job.domainId, docType: 30, docId: tid, uid: row.uid });
    const unexpected = (journal: any[]) => journal.some(j => j.pid === row.pid && String(j.rid) !== String(row.rid) && !target.journal.some(old => digest(old) === digest(j)));
    if (unexpected(current?.journal ?? [])) throw new ImportError(409, '原成绩已变化，已暂停覆盖');
    // Durable backup contains the original journal, never source code. A crash
    // can be resumed with the same reserved record ID and replacement plan.
    const backups = this.db.collection('offline_judge_replacements'), key = `${job._id}:${row.uid}:${row.pid}`;
    await backups.updateOne({ _id: key as any }, { $setOnInsert: { domainId: job.domainId, contestId: job.contestId, jobId: job._id, actor: job.actor, target, createdAt: new Date() } }, { upsert: true });
    for (const record of target.records) {
      const r = await this.db.collection('record').findOne({ _id: new ObjectId(record.id), domainId: job.domainId, uid: row.uid, pid: row.pid });
      if (r?.offlineSuperseded?.jobId === String(job._id) && !r.contest) continue;
      if (!r || String(r.contest) !== job.contestId || r.status !== record.status || r.score !== record.score)
        throw new ImportError(409, '原提交已变化，已暂停覆盖，请核对后继续原批次');
      const changed = await this.db.collection('record').updateOne({ _id: r._id, domainId: job.domainId, contest: tid, status: record.status, score: record.score },
        { $unset: { contest: '' }, $set: { offlineSuperseded: { ...marker, status: record.status, score: record.score }, offlineCorrection: { contestId: job.contestId, at: marker.at, supersededBy: String(job._id) } } });
      if (!changed.modifiedCount) throw new ImportError(409, '原提交正在变化，已暂停覆盖');
    }
    // Remove only the superseded entries. Other problems and contestants retain
    // their journals; native updateStatus recomputes this user's totals next.
    const ids = target.journal.map(j => j.rid);
    for (let attempt = 0; attempt < 10; attempt++) {
      const status = await this.db.collection('document.status').findOne({ domainId: job.domainId, docType: 30, docId: tid, uid: row.uid });
      const remaining = (status?.journal ?? []).filter((j: any) => j.pid === row.pid && String(j.rid) !== String(row.rid));
      if (unexpected(remaining))
        throw new ImportError(409, '原成绩已变化，已暂停覆盖');
      if (!remaining.length) return;
      const changed = await this.db.collection('document.status').updateOne({ _id: status!._id, rev: status!.rev ?? { $exists: false } },
        { $pull: { journal: { pid: row.pid, rid: { $in: ids } } } as any, $inc: { rev: 1 } });
      if (changed.modifiedCount) return;
    }
    throw new ImportError(409, '成绩正在更新，已暂停覆盖，请稍后继续原批次');
  }
}
