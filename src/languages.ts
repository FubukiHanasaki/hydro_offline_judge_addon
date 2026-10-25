// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { ImportError, type InputRow } from './types';
interface Rule { label: string; ids: string[] }
interface LanguageContext { problem?: unknown; contest?: unknown; domain?: unknown; sourceDomain?: unknown }
function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new ImportError(409, `${label}语言配置无效`);
  return value as string[];
}
export function allowedLanguages(languages: Record<string, any>, context: LanguageContext) {
  const rules: Rule[] = [];
  // Match Hydro: missing config is unrestricted; an explicit problem [] disables submissions.
  if (context.problem !== undefined && context.problem !== null) rules.push({ label: '题目', ids: list(context.problem, '题目') });
  if (context.contest !== undefined && context.contest !== null && context.contest !== '') {
    const ids = list(context.contest, '比赛');
    if (ids.length) rules.push({ label: '比赛', ids });
  }
  for (const [label, value] of [['当前子域', context.domain], ['题目来源子域', context.sourceDomain]] as const) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw new ImportError(409, `${label}语言配置无效`);
    rules.push({ label, ids: value.split(',').map(id => id.trim()).filter(Boolean) });
  }
  const includeHidden = rules.some(rule => rule.ids.length);
  const ids = Object.keys(languages).filter(id => {
    const lang = languages[id];
    return lang && !lang.disabled && !lang.isBinary && !lang.remote && (includeHidden || !lang.hidden) && rules.every(rule => rule.ids.includes(id));
  });
  return { ids, rules };
}
export function languageErrors(id: string, languages: Record<string, any>, allowed: ReturnType<typeof allowedLanguages>): string[] {
  if (allowed.ids.includes(id)) return [];
  const errors = allowed.rules.filter(rule => !rule.ids.includes(id)).map(rule => `${rule.label}不允许语言 ${id || '（未匹配）'}`);
  const lang = languages[id];
  if (!lang || lang.disabled || lang.isBinary || lang.remote || !errors.length) errors.push(`该源代码语言未启用或不可用于此题：${id || '（未匹配）'}`);
  return errors;
}

export function applyUploadLanguage(rows: InputRow[], value: unknown): InputRow[] {
  if (value === undefined) {
    if (rows.some(row => row.contestantName && row.file)) throw new ImportError(400, '请选择代码包提交语言');
    return rows;
  }
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,63}$/.test(value)) throw new ImportError(400, '请选择有效的提交语言');
  return rows.map(row => row.file ? { ...row, language: value } : row);
}
