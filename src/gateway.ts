// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { createHash } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { ContestModel, ProblemModel, RecordModel, UserModel, SettingModel, SystemModel, PERM, PRIV, STATUS } from 'hydrooj';
import { ImportError, LIMITS, type Contest, type Gateway, type InputRow, type Job, type Row } from './types';
import { folderLanguage } from './folders';
export class HydroGateway implements Gateway {
  constructor(readonly db: Db) {}
  async authorize(actor: number, domain: string, contestId?: string) {
    const user = await UserModel.getById(domain, actor);
    if (!(actor > 0 && user?._id === actor && user.hasPriv(PRIV.PRIV_USER_PROFILE) && user.hasPerm(PERM.PERM_VIEW_CONTEST))) return false;
    const bridge = (globalThis as any)[Symbol.for('hydro.sms.exams')];
    if (contestId) {
      const managed = await this.db.collection('sms_exams').findOne({ _id: `${domain}:${contestId}` as any });
      if (managed) return bridge ? await bridge.authorize(actor, domain, contestId) === true : false;
      return user.hasPerm(PERM.PERM_EDIT_CONTEST);
    }
    return user.hasPerm(PERM.PERM_EDIT_CONTEST) || !!bridge && await bridge.authorize(actor, domain) === true;
  }
  async participants(actor: number, domain: string, id: string, uids: number[]) {
    const managed = await this.db.collection('sms_exams').findOne({ _id: `${domain}:${id}` as any });
    if (!managed) return;
    const bridge = (globalThis as any)[Symbol.for('hydro.sms.exams')];
    if (!bridge) throw new ImportError(403, 'SMS 模拟赛鉴权不可用');
    try { await bridge.participants(actor, domain, id, uids); }
    catch { throw new ImportError(403, '没有对应班级权限或代码包包含班外账号'); }
  }
  async problem(domain: string, pid: number) {
    const p = await ProblemModel.get(domain, pid);
    if (!p) throw new ImportError(409, `题目 ${pid} 不存在`);
    const effective = p.reference ? await ProblemModel.get(p.reference.domainId, p.reference.pid) : p;
    if (!effective || !effective.config || typeof effective.config === 'string' || !['default', undefined].includes(effective.config.type)) throw new ImportError(409, `题目 ${pid} 需要有效的本地代码评测配置`);
    return { p, effective };
  }
  async contest(domain: string, id: string): Promise<Contest> {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new ImportError(400, '比赛 ID 无效');
    const t = await ContestModel.get(domain, new ObjectId(id));
    if (!t || t.domainId !== domain) throw new ImportError(404, '当前子域中没有这场比赛');
    if (t.rule !== 'oi') throw new ImportError(409, '仅支持 OI 比赛');
    if (!(t.endAt instanceof Date) || t.endAt > new Date()) throw new ImportError(409, '正式代码需要在比赛结束后导入');
    if (t.duration || t.allowTeam || t.assign?.length) throw new ImportError(409, '暂不支持个人计时、团队或分组限定的比赛');
    if (t.lockAt && !t.unlocked) throw new ImportError(409, '请先解除比赛封榜');
    if (!t.pids?.length || t.pids.length > 100) throw new ImportError(409, '比赛需要包含 1–100 道题目');
    const claim = await this.db.collection('offline_judge_contests').findOne({ _id: `${domain}:${id}` as any });
    if (await this.db.collection('record').findOne({ domainId: domain, contest: new ObjectId(id), 'offlineImport.jobId': { $ne: claim ? String(claim.jobId) : '' } }, { projection: { _id: 1 } })) throw new ImportError(409, '比赛已有其他正式提交，请使用专门的离线 OI 比赛');
    if (claim?.state !== 'complete') {
      const bridge=(globalThis as any)[Symbol.for('hydro.sms.exams')];
      const config=await this.db.collection('sms_rating_contests').findOne({_id:`${domain}:${id}` as any});
      const head=await this.db.collection('sms_rating_head').findOne({_id:'global' as any});
      const published=head&&await this.db.collection('sms_rating_sources').findOne({generation:head.generation,key:`contest:${domain}:${id}`});
      if(published)throw new ImportError(409,'比赛已有核验评分，请先由管理员撤销本场评分并核验，再导入正式代码');
      if(config?.enabled&&!(bridge?.reviewRequired&&await bridge.managed(domain,id)))throw new ImportError(409,'请先关闭这场比赛的 Rating 计分，待导入评测完成后再启用');
    }
    const d = await this.db.collection('domain').findOne({ _id: domain as any });
    if (!d) throw new ImportError(404, '子域不存在');
    const problems = [];
    for (const pid of t.pids) { const { p, effective: e } = await this.problem(domain, pid); problems.push([pid, p.reference, e.config, e.data]); }
    const fingerprint = createHash('sha256').update(JSON.stringify([t.title, t.rule, t.beginAt, t.endAt, t.pids, t.score, t.langs, t.lockAt, t.unlocked, d.langs, problems, SettingModel.langs, SystemModel.get('limit.codelength')])).digest('hex');
    return { id, domainId: domain, title: t.title, rule: t.rule, beginAt: t.beginAt, endAt: t.endAt, pids: t.pids, fingerprint };
  }
  async resolve(contest: Contest, rows: InputRow[], ownJob?: string) {
    const seen = new Set<string>();
    const result = [];
    const d = await this.db.collection('domain').findOne({ _id: contest.domainId as any });
    const t = await ContestModel.get(contest.domainId, new ObjectId(contest.id));
    const nameCache=new Map<string,number[]>(),problemAliases=new Map<string,number[]>();
    if(rows.some(r=>r.problemFolder&&!r.manualProblem))for(const pid of contest.pids){const {p,effective}=await this.problem(contest.domainId,pid);for(const value of new Set([p.pid,p.title,effective.config.filename].filter(v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]*$/.test(v)).map(v=>v.toLowerCase()))){problemAliases.set(value,[...(problemAliases.get(value)||[]),pid]);}}
    for (const original of rows) {
      const row={...original};const errors: string[] = [];
      if(row.contestantName&&!row.manualUid){
        let ids=nameCache.get(row.contestantName);
        if(!ids){const users=await this.db.collection('user').find({$or:[{unameLower:row.contestantName.toLowerCase()},{uname:row.contestantName},{displayName:row.contestantName}]},{projection:{_id:1}}).toArray();const students=await this.db.collection('sms_students').find({'basic.name':row.contestantName,hydroUid:{$gt:0}},{projection:{hydroUid:1}}).toArray();let candidates=[...new Set([...users.map(u=>u._id as unknown as number),...students.map(s=>s.hydroUid as number)])];if(contest.domainId!=='system')candidates=await this.db.collection('domain.user').distinct('uid',{domainId:contest.domainId,join:true,uid:{$in:candidates}});ids=candidates;nameCache.set(row.contestantName,ids);}
        if(ids.length!==1){row.uid=0;errors.push(ids.length?'姓名对应多个账号，请指定 UID':'姓名未匹配到当前子域账号，请指定 UID');}
        else if(row.uid>0&&row.uid!==ids[0])errors.push('姓名对应账号已变化，请重新预览');else row.uid=ids[0];
      }
      if(row.problemFolder&&!row.manualProblem){const matches=problemAliases.get(row.problemFolder.toLowerCase())||[];if(matches.length!==1){row.problem='';errors.push(matches.length?'题目英文名不唯一，请指定题目':'题目英文名未匹配，请指定题目');}else{row.problem=String(matches[0]);if('pid'in original&&original.pid&&original.pid!==matches[0])errors.push('题目匹配已变化，请重新预览');}}
      if(row.contestantName&&row.file){row.language=folderLanguage(/\.([^.]+)$/.exec(row.file)?.[1].toLowerCase().replace(/^(cc|cxx)$/,'cpp').replace(/^py$/,'py3')||'',SettingModel.langs);}

      const u = await this.db.collection('user').findOne({ _id: row.uid as any }, { projection: { _id: 1, uname: 1, priv: 1 } });
      if (!u || !((u.priv & PRIV.PRIV_USER_PROFILE) === PRIV.PRIV_USER_PROFILE)) errors.push('账号不存在或已停用');
      const member = await this.db.collection('domain.user').findOne({ domainId: contest.domainId, uid: row.uid, join: true });
      if (!member&&contest.domainId!=='system') errors.push('账号尚未加入当前子域');
      let pid = 0;
      if (row.problem) {
        let index = 0;
        if (/^[A-Z]+$/.test(row.problem)) { for (const c of row.problem) index = index * 26 + c.charCodeAt(0) - 64; pid = contest.pids[index - 1] || 0; }
        else pid = contest.pids.includes(+row.problem) ? +row.problem : 0;
        if (!pid) errors.push('题号不在这场比赛中');
        if (seen.has(`${row.uid}:${pid}`)) errors.push('同一选手同一题只能有一份正式代码');
        seen.add(`${row.uid}:${pid}`);
        const lang = Object.hasOwn(SettingModel.langs, row.language) && SettingModel.langs[row.language];
        if (!lang || lang.disabled || lang.isBinary) errors.push('语言未启用或不是源代码语言，请使用服务器语言 ID');
        if (pid) {
          try {
            const { effective: p } = await this.problem(contest.domainId, pid);
            for (const allowed of [p.config.langs, t.langs, d?.langs?.split(',').map((v: string) => v.trim())]) if (allowed?.length && !allowed.includes(row.language)) errors.push('题目、比赛或子域不允许该语言');
          } catch (e) { errors.push(e instanceof ImportError ? e.message : '无法读取题目'); }
          const existing = await this.db.collection('record').find({ domainId: contest.domainId, contest: new ObjectId(contest.id), uid: row.uid, pid }, { projection: { offlineImport: 1 } }).limit(2).toArray();
          if (existing.some(r => !ownJob || r.offlineImport?.jobId !== ownJob)) errors.push('已有正式比赛提交，不能覆盖');
        }
        if (Buffer.byteLength(row.code) > Math.min(LIMITS.code, SystemModel.get('limit.codelength') || LIMITS.code)) errors.push('代码超过服务器限制');
      }
      result.push({ ...row, pid, username: row.uid>0 ? u?.uname || `UID ${row.uid}` : row.contestantName || '未匹配', errors, rid: new ObjectId() });
    }
    return result;
  }
  async register(job: Job, row: Row) {
    const tid = new ObjectId(job.contestId);
    let status = await ContestModel.getStatus(job.domainId, tid, row.uid);
    if (!status?.attend) {
      try { await ContestModel.attend(job.domainId, tid, row.uid); }
      catch (e) { if (!(await ContestModel.getStatus(job.domainId, tid, row.uid))?.attend) throw e; }
    }
    await ContestModel.setStatus(job.domainId, tid, row.uid, { startAt: (await ContestModel.get(job.domainId, tid)).beginAt, offlineImport: String(job._id) });
    if (!row.pid) return;
    const old = await RecordModel.get(job.domainId, row.rid);
    if (old) {
      if (old.offlineImport?.jobId !== String(job._id) || old.offlineImport?.hash !== row.hash || old.uid !== row.uid || old.pid !== row.pid || String(old.contest) !== job.contestId) throw new ImportError(409, '评测记录与批次不一致，已停止');
    } else {
      // Hydro 5.x RecordModel.add does not accept a caller-owned record ID.
      // Persist a reserved ID using the same initial schema to close its
      // insert-before-ack crash window; actual task creation and score updates
      // are delegated to the native Hydro models. Adapter integration tested.
      try { await RecordModel.coll.insertOne({
        _id: row.rid, domainId: job.domainId, contest: tid, uid: row.uid, pid: row.pid,
        lang: row.language, code: row.code, status: STATUS.STATUS_WAITING,
        score: 0, time: 0, memory: 0, judgeTexts: [], compilerTexts: [], testCases: [], judger: null, judgeAt: null, rejudged: false,
        offlineImport: { jobId: String(job._id), hash: row.hash, actor: job.actor },
      }); } catch (e: any) {
        if (e.code !== 11000) throw e;
        const existing = await RecordModel.get(job.domainId, row.rid);
        if (existing?.offlineImport?.jobId !== String(job._id) || existing?.offlineImport?.hash !== row.hash) throw new ImportError(409, '评测记录冲突');
      }
    }
    const current = await RecordModel.get(job.domainId, row.rid);
    await ContestModel.updateStatus(job.domainId, tid, row.uid, row.rid, row.pid, { status: current.status, score: current.score, subtasks: current.subtasks, lang: row.language });
  }
  async dispatch(job: Job, row: Row) {
    // Deliberately lower priority than ordinary online contest submissions.
    await RecordModel.judge(job.domainId, row.rid, -100, { detail: false }, { type: 'judge' });
  }
  async result(job: Job, row: Row) {
    const r = await RecordModel.get(job.domainId, row.rid);
    if (!r || r.offlineImport?.jobId !== String(job._id)) return { status: null, score: null, terminal: false, queued: false };
    const queued = !!await this.db.collection('task').findOne({ domainId: job.domainId, rid: row.rid }, { projection: { _id: 1 } });
    const s = await ContestModel.getStatus(job.domainId, new ObjectId(job.contestId), row.uid);
    const journal = s?.journal?.find((j: any) => String(j.rid) === String(row.rid));
    const terminal = !!r.judgeAt && [1, 2, 3, 4, 5, 6, 7, 11].includes(r.status) && journal?.status === r.status && journal?.score === r.score;
    return { status: r.status, score: r.score, queued, terminal };
  }
}
