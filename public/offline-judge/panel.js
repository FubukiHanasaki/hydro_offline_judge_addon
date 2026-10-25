/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
  'use strict';
  const app = document.getElementById('offline-app');
  if (!app || app.dataset.ready) return;
  app.dataset.ready = '1';
  const dialog = document.getElementById('offline-import-dialog');
  const $ = id => document.getElementById(`oj-${id}`);
  const base = app.dataset.api, prefix = base.slice(0, base.indexOf('/offline-judge/'));
  const labels = { preview: '待确认', confirming: '正在确认', queued: '等待导入', running: '正在导入', interrupted: '导入中断', attention: '需要检查', judging: '正在评测', complete: '评测完成', cancelled: '已取消', expired: '已过期' };
  const statuses = { 0: '等待评测', 1: '通过', 2: '答案错误', 3: '超时', 4: '内存超限', 5: '输出超限', 6: '运行错误', 7: '编译错误', 8: '系统错误，需重测', 9: '已取消，需重测', 20: '正在评测', 21: '正在编译', 22: '已领取任务' };
  let competition = null, batch = null, serial = 0, timer = null, busy = false;
  function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
  function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
  async function api(url, body) {
    const multipart = body instanceof FormData;
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', 'X-Offline-Judge': '1', ...(!multipart && body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
    let data;
    try { data = await r.json(); } catch { throw Error(`接口返回异常（HTTP ${r.status}），请检查反向代理或服务日志`); }
    if (!r.ok) throw Error(data.message || data.error?.message || `请求失败（HTTP ${r.status}）`);
    if (!Object.hasOwn(data, 'data')) throw Error('接口响应格式异常');
    return data.data;
  }
  function controls() {
    const valid = !!competition && !competition.formalBatch;
    $('upload').hidden = !!competition?.formalBatch;
    $('preview').disabled = busy || !valid;
    $('file').disabled = busy || !valid;
    $('contest').disabled = busy;
    $('refresh').disabled = busy;
    const preview = batch?.state === 'preview';
    $('confirm').hidden = !preview; $('cancel').hidden = !preview; $('consent-wrap').hidden = !preview;
    $('confirm').disabled = busy || !$('consent').checked || batch?.rows.some(r => r.errors.length);
    $('cancel').disabled = busy;
    $('resume').hidden = !batch?.canResume;
    $('actions').hidden = !preview && $('resume').hidden;
    $('resume').disabled = busy;
  }
  function alphabet(index) { let out = ''; for (index++; index > 0; index = Math.floor((index - 1) / 26)) out = String.fromCharCode(65 + (index - 1) % 26) + out; return out; }
  function drawCompetition(c) {
    $('contest-meta').textContent = `${c.title} · ${c.pids.length} 道题 · ${c.formalBatch ? '本场已确认正式代码' : '尚未导入正式代码'}`;
    $('problems').replaceChildren(...c.pids.map((pid, index) => node('p', `${alphabet(index)} · 题目 ${pid}`)));
    $('links').replaceChildren();
    for (const [path, text] of [[`/contest/${c.id}`, '查看比赛'], [`/contest/${c.id}/scoreboard`, '正式成绩榜']]) { const a = node('a', text); a.href = prefix + path; $('links').append(a); }
    $('languages').replaceChildren(...c.languages.map(lang => { const div = node('div', undefined, 'oj-language'); div.append(node('code', lang.id), node('span', ` · ${lang.name}`)); return div; }));
    $('history').replaceChildren();
    if (!c.history.length) $('history').textContent = '暂无导入记录';
    for (const item of c.history) {
      const div = node('div', undefined, 'oj-history-item'), b = node('button', '查看', 'link');
      b.type = 'button'; b.addEventListener('click', () => openBatch(item.id).catch(e => notice(e.message)));
      div.append(node('span', `${new Date(item.createdAt).toLocaleString()} · ${item.count} 行 · ${labels[item.state] || item.state}`), b); $('history').append(div);
    }
    controls();
  }
  async function loadCompetition() {
    const version = ++serial;
    clearTimeout(timer); batch = null; competition = null; $('preview-section').hidden = true; $('consent').checked = false; notice(); controls();
    const id = $('contest').value;
    if (!id) { $('contest-meta').textContent = '当前子域暂无已结束的 OI 比赛'; return; }
    try {
      const c = await api(`${base}/${encodeURIComponent(id)}`);
      if (version !== serial) return;
      competition = c; drawCompetition(c);
      if (c.formalBatch) await openBatch(c.formalBatch.id);
    } catch (e) { if (version === serial) notice(e.message); }
  }
  async function refreshDetails() {
    const version = serial, id = $('contest').value;
    const c = await api(`${base}/${encodeURIComponent(id)}`);
    if (version === serial && id === $('contest').value) { competition = c; drawCompetition(c); }
  }
  function drawBatch(value) {
    const previous = batch?.id;
    batch = value; if (previous !== value.id) $('consent').checked = false;
    $('preview-section').hidden = false;
    $('batch-title').textContent = batch.state === 'preview' ? '导入前预览' : '正式导入批次';
    $('state').textContent = labels[batch.state] || batch.state;
    $('job-error').textContent = batch.error; $('job-error').hidden = !batch.error;
    $('summary').replaceChildren();
    const submitted = batch.rows.filter(r => r.pid), done = submitted.filter(r => r.result?.terminal).length;
    for (const [title, value] of [['参赛选手', batch.participants], ['代码文件', submitted.length], ['已完成评测', done], ['检查错误', batch.rows.filter(r => r.errors.length).length]]) {
      const div = node('div', title, 'oj-stat'); div.append(node('strong', String(value))); $('summary').append(div);
    }
    $('rows').replaceChildren(); $('mobile-rows').replaceChildren();
    for (const row of batch.rows) {
      const tr = node('tr'), user = node('td', row.username); user.append(node('small', `UID ${row.uid}`));
      const problem = node('td', row.problem ? `${row.problem} · ${row.pid || '未匹配'}` : '仅登记参赛'); problem.append(node('small', row.file || '未提交代码'));
      const check = node('td');
      if (row.errors.length) check.append(node('span', row.errors.join('；'), 'oj-error'));
      else if (!row.pid) check.append(node('span', batch.state === 'preview' ? '将登记参赛' : '已登记参赛'));
      else if (row.result) check.append(node('span', statuses[row.result.status] || '等待检查'));
      else check.append(node('span', batch.state === 'preview' ? '检查通过' : '等待导入'));
      if (row.rid) { const a = node('a', '评测记录'); a.href = `${prefix}/record/${encodeURIComponent(row.rid)}`; const small = node('small'); small.append(a); check.append(small); }
      const score = node('td', row.result?.terminal ? String(row.result.score) : '—');
      tr.append(user, problem, node('td', row.language || '—'), check, score); $('rows').append(tr);
      const card = node('div', undefined, 'oj-mobile-card'), head = node('div', undefined, 'oj-card-head');
      const person = node('div'), points = node('div', row.result?.terminal ? String(row.result.score) : '—', 'oj-card-score');
      for (const child of user.childNodes) person.append(child.cloneNode(true));
      points.prepend(node('small', '分数')); head.append(person, points);
      const file = node('div', undefined, 'oj-card-file'); for (const child of problem.childNodes) file.append(child.cloneNode(true));
      const foot = node('div', undefined, 'oj-card-foot'), state = node('div');
      for (const child of check.childNodes) state.append(child.cloneNode(true));
      foot.append(node('span', row.language ? `语言：${row.language}` : '无代码'), state);
      card.append(head, file, foot); $('mobile-rows').append(card);
    }
    controls();
  }
  async function openBatch(id) {
    const version = serial, contestId = $('contest').value;
    const value = await api(`${app.dataset.batches}/${encodeURIComponent(id)}`);
    if (version !== serial || value.contestId !== contestId) return;
    const wasComplete = batch?.state === 'complete';
    drawBatch(value); schedulePoll();
    if (value.state === 'complete' && !wasComplete) await refreshDetails();
  }
  function schedulePoll() {
    clearTimeout(timer);
    if (dialog && !dialog.open) return;
    if (!batch || !['queued', 'running', 'judging', 'confirming'].includes(batch.state)) return;
    const id = batch.id;
    timer = setTimeout(() => openBatch(id).catch(e => notice(e.message)), 3000);
  }
  async function action(operation) {
    if (!batch || busy) return;
    if (operation === 'confirm' && (!$('consent').checked || batch.rows.some(r => r.errors.length))) return;
    busy = true; controls(); notice();
    try {
      const value = await api(`${app.dataset.batches}/${encodeURIComponent(batch.id)}`, { action: operation, revision: batch.revision });
      drawBatch(value);
      if (operation !== 'cancel') competition.formalBatch = { id: value.id, state: value.state };
      await refreshDetails();
      schedulePoll();
    } catch (e) { notice(e.message); }
    finally { busy = false; controls(); }
  }
  $('upload').addEventListener('submit', async e => {
    e.preventDefault(); if (busy || !competition || competition.formalBatch) return;
    const file = $('file').files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { notice('ZIP 不能超过 10 MB'); return; }
    busy = true; controls(); notice();
    const version = serial;
    try { const data = new FormData(); data.append('file', file); const preview = await api(`${base}/${encodeURIComponent(competition.id)}`, data); if (version === serial) { drawBatch(preview); $('preview-section').scrollIntoView({ behavior: 'auto', block: 'start' }); } }
    catch (e) { notice(e.message); }
    finally { busy = false; controls(); }
  });
  $('confirm').addEventListener('click', () => action('confirm'));
  $('cancel').addEventListener('click', () => action('cancel'));
  $('resume').addEventListener('click', () => action('resume'));
  $('consent').addEventListener('change', controls);
  $('contest').addEventListener('change', loadCompetition);
  $('refresh').addEventListener('click', loadCompetition);
  $('format').addEventListener('click', () => { const expanded = $('format-body').hidden; $('format-body').hidden = !expanded; $('format').setAttribute('aria-expanded', String(expanded)); });
  $('manifest').addEventListener('click', () => {
    const lang = competition?.languages.find(l => l.id === 'cc.cc17o2')?.id || competition?.languages[0]?.id || '服务器语言ID';
    const blob = new Blob(['\ufeffuid,problem,file,language\r\n', `246,A,code/246/A.cpp,${lang}\r\n247,,,\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = node('a'); a.download = 'submissions.csv'; a.href = URL.createObjectURL(blob); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  window.addEventListener('pagehide', () => clearTimeout(timer));
  async function openImporter() {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    if (busy) return;
    try {
      if (!competition) await loadCompetition();
      else { await refreshDetails(); if (batch) await openBatch(batch.id); }
    } catch (e) { notice(e.message); controls(); }
  }
  if (dialog) {
    const existing = document.querySelector('[data-offline-open]');
    if (!existing) {
      const header = document.querySelector('.row > .medium-9.columns > .section:first-child > .section__header');
      if (header) {
        const tools = node('div', undefined, 'oj-native-entry');
        const entry = node('button', '提交离线代码包', 'tool-button');
        entry.type = 'button'; entry.dataset.offlineOpen = ''; tools.append(entry); header.append(tools);
      }
    }
    document.querySelectorAll('[data-offline-open]').forEach(b => b.addEventListener('click', openImporter));
    dialog.querySelectorAll('[data-offline-close]').forEach(b => b.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => clearTimeout(timer));
    window.addEventListener('hashchange', () => { if (location.hash === '#offline-code') void openImporter(); });
    if (location.hash === '#offline-code') void openImporter();
  }
})();
