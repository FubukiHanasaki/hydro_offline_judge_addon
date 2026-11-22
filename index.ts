// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { readFile, stat } from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { Context, Handler, ForbiddenError, PERM, PRIV, RecordModel, SettingModel, ContestModel, UserModel } from 'hydrooj';
import { HydroGateway } from './src/gateway';
import { ImportService } from './src/service';
import { ImportError, LIMITS } from './src/types';
import { SettingsStore } from './src/contest-settings';
import { installContestIo } from './src/contest-io';
import { installCorrectionRecords } from './src/correction-records';
export const name = 'hydro-offline-judge';
export const inject = ['db'];
export async function apply(ctx: Context) {
  const db = ctx.db.db, gateway = new HydroGateway(db), service = new ImportService(db, gateway);
  await service.init();
  installContestIo(ctx,db);
  const settings=new SettingsStore(db);
  const canConfigure=async(actor:number,domain:string,id:string)=>{
    const bridge=(globalThis as any)[Symbol.for('hydro.sms.exams')];
    if(bridge)return typeof bridge.configure==='function'&&await bridge.configure(actor,domain,id)===true;
    const user=await UserModel.getById(domain,actor);return !!user?.hasPriv(PRIV.PRIV_USER_PROFILE)&&user.hasPerm(PERM.PERM_EDIT_CONTEST);
  };
  const settingsContest=async(domain:string,id:string)=>{
    if(!/^[a-f\d]{24}$/i.test(id))throw new ImportError(400,'比赛 ID 无效');
    const c=await ContestModel.get(domain,new ObjectId(id));if(!c||c.rule!=='oi')throw new ImportError(404,'OI 比赛不存在');return c;
  };
  const settingsView=async(domain:string,id:string)=>{const c=await settingsContest(domain,id),value=await settings.read(domain,id);const problems=[];for(const pid of c.pids){const {p,effective}=await gateway.problem(domain,pid);problems.push({pid,title:p.title,label:p.pid||String(pid),originalFilename:effective.config.filename||'',...value.problems[String(pid)]??{name:'',io:'inherit',filename:''}});}return {version:value.version,ioLocked:!!value.ioLocked,problems};};
  installCorrectionRecords(ctx, 'offlineCorrection', async (h, record, id) => {
    const claim = await service.claims.findOne({ _id: `${h.domain._id}:${id}`, state: 'complete' });
    if (!claim) return null;
    const managed = await db.collection('sms_exams').findOne({ _id: `${h.domain._id}:${id}` as any });
    if (managed) {
      const bridge = (globalThis as any)[Symbol.for('hydro.sms.exams')];
      return bridge?.correctionRecord ? bridge.correctionRecord(h.user._id, h.domain._id, id, record.uid) : null;
    }
    const contest = await ContestModel.get(h.domain._id, new ObjectId(id));
    return contest?.rule === 'oi' ? contest : null;
  });
  ctx.effect(()=>{const key=Symbol.for('hydro.offline-judge');const marker={installed:true};(globalThis as any)[key]=marker;return()=>{if((globalThis as any)[key]===marker)delete(globalThis as any)[key];};});
  let parsing = 0;
  class Api extends Handler {
    settingsAccess=false;
    async prepare() {
      this.response.addHeader('Cache-Control', 'private, no-store');
      this.response.addHeader('Vary', 'Cookie, Authorization');
      if (!this.user?._id || !(this.settingsAccess?await canConfigure(this.user._id,this.domain._id,this.context.params.tid):await gateway.authorize(this.user._id, this.domain._id))) throw new ForbiddenError();
      if(this.settingsAccess){let ceiling:bigint;try{ceiling=BigInt((this as any).session?.scope??this.user.scope??0);}catch{throw new ForbiddenError();}if(!(ceiling&PERM.PERM_EDIT_CONTEST)&&!(ceiling&PERM.PERM_EDIT_CONTEST_SELF))throw new ForbiddenError();}
      if (this.context.method !== 'GET') {
        const destination = `${this.context.request.protocol}://${this.context.request.host}`;
        if (this.context.get('origin') !== destination || this.context.get('x-offline-judge') !== '1') throw new ForbiddenError();
      }
    }
    async run(fn: () => Promise<unknown>) {
      this.response.type = 'application/json';
      try { this.response.body = { data: await fn() }; }
      catch (e) {
        this.response.status = e instanceof ImportError ? e.status : 500;
        this.response.body = { message: e instanceof ImportError ? e.message : '服务暂时异常，请稍后重试' };
        if (!(e instanceof ImportError)) console.error('[offline-judge] request failed:', e instanceof Error ? e.name + '\n' + (e.stack || '').split('\n').slice(1).join('\n') : 'UnknownError');
      }
    }
  }
  class Settings extends Api {
    settingsAccess=true;
    async get(){await this.run(()=>settingsView(this.domain._id,this.context.params.tid));}
    async post(){await this.run(async()=>{
      if(!this.context.is('application/json'))throw new ImportError(400,'需要 JSON 请求');
      const b=this.context.request.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['version','problems'].includes(k)))throw new ImportError(400,'设置格式无效');
      const c=await settingsContest(this.domain._id,this.context.params.tid);
      for(const [pid,value]of Object.entries(b.problems??{})){if(!c.pids.includes(Number(pid)))throw new ImportError(400,'题目不在当前比赛');const {effective}=await gateway.problem(this.domain._id,Number(pid));const v=value as any;if(effective.config.filename&&v?.io!=='inherit'&&(v?.io!=='file'||v?.filename!==effective.config.filename))throw new ImportError(400,'原题已使用文件 IO，需要沿用原题或保留原文件名');}
      await gateway.withMutation(async verify=>{await verify();await settings.save(this.user._id,this.domain._id,String(c.docId),c.pids,b.version,b.problems);});
      return settingsView(this.domain._id,String(c.docId));
    });}
  }
  class Main extends Handler {
    async get() {
      if (!this.user?._id || !await gateway.authorize(this.user._id, this.domain._id)) throw new ForbiddenError();
      this.response.addHeader('Cache-Control', 'private, no-store');
      const tid = typeof this.context.query.tid === 'string' ? this.context.query.tid : '';
      if (tid && (!/^[a-f\d]{24}$/i.test(tid) || !await gateway.authorize(this.user._id, this.domain._id, tid))) throw new ForbiddenError();
      this.response.redirect = tid ? this.url('contest_detail', { tid }) + '#offline-code' : this.url('contest_main');
    }
  }
  class Contests extends Api {
    async get() { await this.run(async () => {
      const contests = await db.collection('document').find({ domainId: this.domain._id, docType: 30, rule: 'oi', endAt: { $lte: new Date() } }, { projection: { docId: 1, title: 1, beginAt: 1, endAt: 1 } }).sort({ endAt: -1 }).limit(200).toArray();
      const allowed=[];for(const t of contests)if(await gateway.authorize(this.user._id,this.domain._id,String(t.docId)))allowed.push({id:String(t.docId),title:t.title,endAt:t.endAt});return allowed;
    }); }
  }
  class Competition extends Api {
    async get() { await this.run(async () => {
      const contest = await service.competition(this.user._id, this.domain._id, this.context.params.tid);
      // Config endpoint is authorized, but never returns test data or secrets.
      const langs = Object.entries(SettingModel.langs).filter(([, v]) => !v.disabled && !v.isBinary && !v.remote).map(([id, v]) => ({ id, name: v.display || id }));
      const configured=await settings.read(contest.domainId,contest.id);
      const problems=[];for(const pid of contest.pids){const {p}=await gateway.problem(contest.domainId,pid);problems.push({pid,title:p.title,label:p.pid||String(pid),englishName:configured.problems[String(pid)]?.name||''});}
      return { ...contest, problems, settingsUrl:await canConfigure(this.user._id,contest.domainId,contest.id)?this.url('contest_edit',{tid:contest.id})+'#offline-contest-settings':null, languages: langs, history: await service.history(this.user._id, this.domain._id, contest.id) };
    }); }
    async post() { await this.run(async () => {
      if (!this.context.is('multipart/form-data')) throw new ImportError(400, '请上传 ZIP 文件');
      const file = this.request.files?.file;
      if (!file || Array.isArray(file) || Object.keys(this.request.files || {}).length !== 1 || !/\.zip$/i.test(file.originalFilename || '') || file.size < 1 || file.size > LIMITS.zip) throw new ImportError(400, '请选择不超过 10 MB 的 ZIP 文件');
      if (parsing >= 2) throw new ImportError(429, '正在处理其他代码包，请稍后重试');
      parsing++;
      try {
        const info = await stat(file.filepath);
        if (!info.isFile() || info.size !== file.size || info.size > LIMITS.zip) throw new ImportError(400, '上传文件大小不正确');
        const raw=this.context.request.body?.mapping;let mapping:unknown;
        if(raw!==undefined){if(typeof raw!=='string'||raw.length>65536)throw new ImportError(400,'匹配设置过大');try{mapping=JSON.parse(raw);}catch{throw new ImportError(400,'匹配设置格式错误');}}
        return await service.preview(this.user._id, this.domain._id, this.context.params.tid, await readFile(file.filepath),mapping,this.context.request.body?.language);
      } finally { parsing--; }
    }); }
  }
  class Batch extends Api {
    async get() { await this.run(() => service.view(this.user._id, this.domain._id, this.context.params.id)); }
    async post() { await this.run(async () => {
      if (!this.context.is('application/json')) throw new ImportError(400, '需要 JSON 请求');
      const b = this.context.request.body;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['action', 'revision', 'mapping', 'language', 'acknowledgeOverwrite'].includes(k)) || b.acknowledgeOverwrite !== undefined && typeof b.acknowledgeOverwrite !== 'boolean') throw new ImportError(400, '请求格式错误');
      if(b.action==='match'){if(!Number.isSafeInteger(b.revision))throw new ImportError(400,'版本无效');return service.match(this.user._id,this.domain._id,this.context.params.id,b.revision,b.mapping,b.language);}
      const fn = b.action === 'confirm' ? service.confirm : b.action === 'cancel' ? service.cancel : b.action === 'resume' ? service.resume : null;
      if (!fn || !Number.isSafeInteger(b.revision)) throw new ImportError(400, '操作或版本无效');
      if (b.action === 'confirm') return service.confirm(this.user._id, this.domain._id, this.context.params.id, b.revision, b.acknowledgeOverwrite === true);
      return fn.call(service, this.user._id, this.domain._id, this.context.params.id, b.revision);
    }); }
  }
  ctx.Route('offline_judge_settings','/offline-judge/api/settings/:tid',Settings);
  ctx.on('handler/after/ContestEdit',async(h:any)=>{
    if(h.context.method!=='GET'||h.tdoc?.rule!=='oi'||!await canConfigure(h.user._id,h.domain._id,String(h.tdoc.docId)))return;
    if(!['contest_edit.html','sms_contest_edit.html'].includes(h.response.template))return;
    h.response.body.offlineEditBaseTemplate=h.response.template;h.response.body.offlineSettingsApi=h.url('offline_judge_settings',{tid:String(h.tdoc.docId)});h.response.template='offline_contest_edit.html';
  });
  ctx.Route('offline_judge_main', '/offline-judge', Main);
  ctx.Route('offline_judge_contests', '/offline-judge/api/contests', Contests);
  ctx.Route('offline_judge_competition', '/offline-judge/api/contests/:tid', Competition);
  ctx.Route('offline_judge_batch', '/offline-judge/api/batches/:id', Batch);

  // Native submit form remains usable. For a managed contest it is a correction:
  // preserve native language/file/rate/security validation, remove only the
  // contest association when calling native post, so the judge callback cannot
  // change formal contest journals, ranking, or Rating.
  ctx.on('handler/before-prepare/ProblemSubmit', async (h: any) => {
    const tid = String(h.args.tid || '');
    if (!/^[a-f\d]{24}$/i.test(tid)) return;
    const sms=(globalThis as any)[Symbol.for('hydro.sms.exams')];
    if(sms&&await sms.managed(h.domain._id,tid))return;
    const claim = await service.claims.findOne({ _id: `${h.domain._id}:${tid}` });
    if (!claim) return;
    h.args.domainId = h.domain._id;
    h.args.pid = h.context.params.pid;
    const post = h.post.bind(h);
    h.prepare = async function(args: any) {
      if (claim.state !== 'complete' || !h.tsdoc?.attend || !h.user?._id) throw new ForbiddenError();
      if (h.tdoc?.rule !== 'oi' || h.tdoc.domainId !== h.domain._id || h.tdoc.endAt > new Date()) throw new ForbiddenError();
      const config = h.pdoc?.config;
      if (!config || typeof config === 'string' || !['default', undefined].includes(config.type) || (config.langs && !config.langs.length)) throw new ForbiddenError();
      h.offlineCorrection = true;
      // Native prepare only adds ongoing-contest and config checks. The config
      // checks above remain enforced while allowing post-contest corrections.
    };
    h.post = async function(args: any) {
      const fresh = await service.claims.findOne({ _id: `${h.domain._id}:${tid}`, state: 'complete' });
      if (!fresh || !h.tsdoc?.attend) throw new ForbiddenError();
      if (h.context.get('origin') !== `${h.context.request.protocol}://${h.context.request.host}`) throw new ForbiddenError();
      const officialTid = args.tid;
      delete args.tid;
      try {
        await post(args);
        const rid = h.response.body?.rid;
        if (rid && ObjectId.isValid(String(rid))) await RecordModel.coll.updateOne({ _id: new ObjectId(String(rid)), domainId: h.domain._id, uid: h.user._id, contest: { $exists: false } }, { $set: { offlineCorrection: { contestId: tid, at: new Date() } } });
      } finally { args.tid = officialTid; }
    };
  });
  ctx.on('handler/after/ProblemSubmit', async (h: any) => {
    if (h.offlineCorrection && h.response.template === 'problem_submit.html') h.response.template = 'offline_problem_submit.html';
  });
  // The importer belongs to one native OI contest; no standalone feature page.
  ctx.on('handler/after/ContestDetail', async (h: any) => {
    const tid = String(h.tdoc?.docId || '');
    if (h.tdoc?.rule !== 'oi' || h.tdoc.endAt > new Date() || !/^[a-f\d]{24}$/i.test(tid)) return;
    if (!['contest_detail.html', 'sms_contest_detail.html'].includes(h.response.template)) return;
    if (!await gateway.authorize(h.user?._id || 0, h.domain._id, tid)) return;
    const formalBatch = await service.claims.findOne({ _id: `${h.domain._id}:${tid}` });
    h.response.addHeader('Cache-Control', 'private, no-store');
    h.response.addHeader('Vary', 'Cookie, Authorization');
    Object.assign(h.response.body, {
      offlineBaseTemplate: h.response.template,
      offlineApi: h.url('offline_judge_contests'),
      offlineBatchBase: h.url('offline_judge_batch', { id: '000000000000000000000000' }).replace(/\/0{24}$/, ''),
      offlineSelected: tid,
      offlineEntryLabel: formalBatch ? '查看离线代码包' : '提交离线代码包',
    });
    h.response.template = 'offline_contest_detail.html';
  });
  ctx.effect(() => {
    const timer = setInterval(() => { void service.tick().catch(() => console.error('[offline-judge] worker tick failed')); }, 1000);
    timer.unref();
    return () => clearInterval(timer);
  });
}
