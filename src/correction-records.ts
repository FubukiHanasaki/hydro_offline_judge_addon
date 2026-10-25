// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { Context, RecordModel, ProblemModel, ContestModel, UserModel, ForbiddenError, PERM, PRIV } from 'hydrooj';
import { ObjectId } from 'mongodb';

// Corrections stay outside formal contest records. Restore only the verified
// owner's contest context for the native record page and its live connection.
export function installCorrectionRecords(ctx: Context, marker: string, resolve: (h: any, record: any, id: string) => Promise<any>) {
  async function access(h: any, record?: any) {
    const rid = String(h.args?.rid || '');
    if (!/^[a-f\d]{24}$/i.test(rid)) return null;
    const r = record || await RecordModel.get(h.domain._id, new ObjectId(rid));
    if (!r || r.contest || !r[marker]) return null;
    const id = String(r[marker].contestId || '');
    if (!/^[a-f\d]{24}$/i.test(id) || h.args.tid && String(h.args.tid) !== id) throw new ForbiddenError();
    const user = await UserModel.getById(h.domain._id, h.user._id);
    if (!user?.hasPriv(PRIV.PRIV_USER_PROFILE) || !user.hasPerm(PERM.PERM_VIEW_CONTEST)) throw new ForbiddenError();
    const contest = await resolve(h, r, id);
    if (!contest || contest.domainId !== h.domain._id || +new Date(contest.endAt) > Date.now() || !contest.pids?.includes(r.pid)) throw new ForbiddenError();
    if (contest.assign?.length && !user.own(contest) && !user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
      const groups = await UserModel.listGroup(h.domain._id, h.user._id);
      if (!groups.some((g: any) => contest.assign.includes(g.name))) throw new ForbiddenError();
    }
    // Check the source contest's scope even when native code permissions will
    // decide access for another viewer. Never grant that viewer the owner path.
    if (r.uid !== h.user._id) return null;
    const status = await ContestModel.getStatus(h.domain._id, new ObjectId(id), h.user._id);
    if (!status?.attend) return null;
    return { record: r, contest };
  }
  ctx.on('handler/before-prepare/RecordDetail#get', async (h: any) => {
    const context = await access(h);
    if (context) h.args.tid = context.contest.docId;
  });
  ctx.on('handler/create/ws' as any, async (h: any) => {
    if (h.constructor.name !== 'RecordDetailConnectionHandler') return;
    const original = h.prepare.bind(h);
    h.prepare = async (args: any) => {
      const rid = String(h.args?.rid || '');
      const record = /^[a-f\d]{24}$/i.test(rid) ? await RecordModel.get(h.domain._id, new ObjectId(rid)) : undefined;
      const context = await access(h, record);
      if (record?.[marker] && !record.contest && h.context.get('origin') !== `${h.context.request.protocol}://${h.context.request.host}`) throw new ForbiddenError();
      if (!context) return original(args);
      h.pdoc = await ProblemModel.get(h.domain._id, context.record.pid);
      if (!h.pdoc) throw new ForbiddenError();
      h.tdoc = context.contest;
      h.rid = String(context.record._id);
      h.canViewCode = true;
      h.noTemplate = [true, 1, 'true', '1'].includes(args.noTemplate);
      let timer: ReturnType<typeof setTimeout> | undefined, latest: any;
      const cleanup = h.cleanup?.bind(h);
      h.cleanup = async (value: any) => {
        clearTimeout(timer); clearTimeout(h.disconnectTimeout);
        await cleanup?.(value);
      };
      h.throttleSend = (record: any) => {
        latest = record;
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          void access(h, latest).then(value => {
            if (!value) throw new ForbiddenError();
            return h.sendUpdate(latest);
          }).catch(() => h.close(4003, 'Forbidden'));
        }, 100);
      };
      await h.onRecordChange(context.record);
    };
  });
}
