// Compile only the host API boundary used by this addon; real Hydro integration
// tests exercise this boundary separately from the business modules.
import type { Db } from 'mongodb';
export interface Context { db: {db: Db}; Route(name: string, path: string, handler: typeof Handler, ...checks: any[]): void; injectUI(node: string, name: string, args: Record<string, unknown>, ...checks: any[]): void; on(event: string, callback: (...args: any[]) => any): void; effect(fn: () => () => void): void; i18n: {load(lang: string, values: Record<string,string>): void}; }
export class Handler { args: any; domain: any; user: any; request: any; context: any; response: any; checkPerm(perm: bigint): void; checkPriv(priv: number): void; url(name: string, args?: any): string; }
export const ContestModel: any;
export const ProblemModel: any;
export const RecordModel: any;
export const UserModel: any;
export const SettingModel: { langs: Record<string, any> };
export const SystemModel: { get(key: string): any };
export const STATUS: Record<string, number>;
export const PERM: Record<string, bigint>;
export const PRIV: Record<string, number>;
export class ForbiddenError extends Error {}
