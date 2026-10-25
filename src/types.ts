// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import type { ObjectId } from 'mongodb';
export class ImportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const LIMITS = Object.freeze({ zip: 10 * 1024 * 1024, expanded: 20 * 1024 * 1024, code: 128 * 1024, manifest: 256 * 1024, rows: 500, entries: 1500, previewMs: 24 * 3600_000 });
export interface InputRow { contestantName?: string; problemFolder?: string; manualUid?: boolean; manualProblem?: boolean; line: number; uid: number; problem: string; file: string; language: string; code: string; hash: string; }
export interface Contest { id: string; title: string; domainId: string; rule: string; beginAt: Date; endAt: Date; pids: number[]; fingerprint: string; }
export interface ResolvedRow extends InputRow { pid: number; username: string; errors: string[]; rid: ObjectId; }
export type RowState = 'pending' | 'registered' | 'dispatching' | 'queued';
export interface StoredRow extends ResolvedRow { state: RowState; }
export type JobState = 'preview' | 'confirming' | 'queued' | 'running' | 'interrupted' | 'attention' | 'judging' | 'complete' | 'cancelled' | 'expired';
export interface Job {
  _id: ObjectId; domainId: string; contestId: string; title: string; actor: number;
  fingerprint: string; digest: string; state: JobState; revision: number; count: number;
  createdAt: Date; updatedAt: Date; expiresAt: Date; error: string;
  token?: string; heartbeat?: Date; ignoredFiles?: string[];
}
export interface Row extends StoredRow { _id: string; jobId: ObjectId; domainId: string; contestId: string; }
export interface Gateway {
  contest(domain: string, id: string): Promise<Contest>;
  resolve(contest: Contest, rows: InputRow[], ownJob?: string): Promise<ResolvedRow[]>;
  authorize(actor: number, domain: string, contestId?: string): Promise<boolean>;
  participants?(actor: number, domain: string, id: string, uids: number[]): Promise<void>;
  register(job: Job, row: Row): Promise<void>;
  dispatch(job: Job, row: Row): Promise<void>;
  result(job: Job, row: Row): Promise<{ status: number | null; score: number | null; terminal: boolean; queued: boolean; }>;
}
