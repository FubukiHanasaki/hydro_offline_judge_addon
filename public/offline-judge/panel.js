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
  let competition = null, batch = null, serial = 0, timer = null, busy = false, uploadedFile = null, mappingDirty = false;
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
    $('preview').disabled = busy || !valid || !$('language').value;
    $('language').disabled = busy || !valid;
    $('file').disabled = busy || !valid;
    $('contest').disabled = busy;
    $('refresh').disabled = busy;
    $('mapping').querySelectorAll('input,select,button').forEach(el=>el.disabled=busy||!uploadedFile);
    const preview = batch?.state === 'preview';
    $('confirm').hidden = !preview; $('cancel').hidden = !preview; $('consent-wrap').hidden = !preview;
    $('confirm').disabled = busy || mappingDirty || !$('consent').checked || batch?.rows.some(r => r.errors.length);
    $('cancel').disabled = busy;
    $('resume').hidden = !batch?.canResume;
    $('actions').hidden = !preview && $('resume').hidden;
    $('resume').disabled = busy;
  }
  function alphabet(index) { let out = ''; for (index++; index > 0; index = Math.floor((index - 1) / 26)) out = String.fromCharCode(65 + (index - 1) % 26) + out; return out; }
  function drawCompetition(c) {
    document.getElementById('offline-import-title').textContent = '提交离线代码包 · ' + c.title;
    $('problems').replaceChildren(...c.pids.map((pid, index) => node('p', `${alphabet(index)} · 题目 ${pid}`)));
    const chosen=$('language').value;const empty=node('option','请选择语言');empty.value='';$('language').replaceChildren(empty,...c.languages.map(lang=>{const option=node('option',`${lang.name} (${lang.id})`);option.value=lang.id;return option;}));$('language').value=c.languages.some(lang=>lang.id===chosen)?chosen:'';
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
    if (!id) { notice('比赛 ID 缺失'); return; }
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
    batch = value; mappingDirty = false; if (previous !== value.id) $('consent').checked = false;
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
      const tr = node('tr'), user = node('td', row.username); user.append(node('small', row.uid>0?`UID ${row.uid}`:'未匹配 UID'));
      const problem = node('td', row.problemFolder ? `${row.problemFolder} · ${row.pid || '未匹配'}` : row.problem ? `${row.problem} · ${row.pid || '未匹配'}` : '仅登记参赛'); problem.append(node('small', row.file || '未提交代码'));
      const check = node('td');
      if (row.errors.length) {const message=node('span',row.errors.join('；'),'oj-error');message.title=message.textContent;check.append(message);}
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
    drawMapping();controls();
  }
  function drawMapping() {
    const box=$('mapping');box.replaceChildren();
    const folderRows=batch?.rows.filter(r=>r.contestantName)||[];
    box.hidden=!folderRows.length||batch.state!=='preview';if(box.hidden)return;
    const grid=node('div',undefined,'oj-match-grid');
    function changed(){mappingDirty=true;$('consent').checked=false;controls();}
    for(const name of new Set(folderRows.map(r=>r.contestantName))){const row=folderRows.find(r=>r.contestantName===name),label=node('label',name),input=node('input');input.type='number';input.min='1';input.step='1';input.className='textbox';input.placeholder='Hydro UID';input.dataset.person=name;input.value=row.uid>0?String(row.uid):'';input.addEventListener('input',changed);label.append(input);grid.append(label);}
    for(const name of new Set(folderRows.map(r=>r.problemFolder).filter(Boolean))){const row=folderRows.find(r=>r.problemFolder===name),label=node('label',name),select=node('select',undefined,'select'),empty=node('option','选择比赛题目');empty.value='';select.append(empty);select.dataset.problem=name;for(const p of competition.problems||[]){const o=node('option',`${p.label} · ${p.title}`);o.value=String(p.pid);select.append(o);}select.value=row.pid?String(row.pid):'';select.addEventListener('change',changed);label.append(select);grid.append(label);}
    const apply=node('button','应用匹配','rounded button');apply.type='button';apply.disabled=!uploadedFile||busy;apply.addEventListener('click',async()=>{
      if(busy||!uploadedFile)return;if(!$('language').value){notice('请选择代码包提交语言');return;}const people=Object.create(null),problems=Object.create(null);
      for(const el of box.querySelectorAll('[data-person]')){const uid=Number(el.value);if(!Number.isSafeInteger(uid)||uid<=0){notice('请为每名选手填写有效 UID');return;}people[el.dataset.person]=uid;}
      for(const el of box.querySelectorAll('[data-problem]')){if(!el.value){notice('请选择每个目录对应的比赛题目');return;}problems[el.dataset.problem]=Number(el.value);}
      busy=true;controls();apply.disabled=true;notice();
      try {const old=batch;if(old.state==='preview'){await api(`${app.dataset.batches}/${encodeURIComponent(old.id)}`,{action:'cancel',revision:old.revision});old.state='cancelled';}mappingDirty=true;const data=new FormData();data.append('file',uploadedFile);data.append('language',$('language').value);data.append('mapping',JSON.stringify({people,problems}));const value=await api(`${base}/${encodeURIComponent(competition.id)}`,data);drawBatch(value);}
      catch(e){notice(e.message);}
      finally{busy=false;apply.disabled=false;controls();}
    });box.append(grid,apply);
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
    if (operation === 'confirm' && (mappingDirty || !$('consent').checked || batch.rows.some(r => r.errors.length))) return;
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
    e.preventDefault(); if (busy || !competition || competition.formalBatch || !$('language').value) return;
    const file = $('file').files[0]; if (!file) return; uploadedFile = file;
    if (file.size > 10 * 1024 * 1024) { notice('ZIP 不能超过 10 MB'); return; }
    busy = true; controls(); notice();
    const version = serial;
    try { const data = new FormData(); data.append('file', file); data.append('language',$('language').value); const preview = await api(`${base}/${encodeURIComponent(competition.id)}`, data); if (version === serial) { drawBatch(preview); $('preview-section').scrollIntoView({ behavior: 'auto', block: 'start' }); } }
    catch (e) { notice(e.message); }
    finally { busy = false; controls(); }
  });
  $('confirm').addEventListener('click', () => action('confirm'));
  $('cancel').addEventListener('click', () => action('cancel'));
  $('resume').addEventListener('click', () => action('resume'));
  $('consent').addEventListener('change', controls);
  $('language').addEventListener('change',()=>{if(batch?.state==='preview'){mappingDirty=true;$('consent').checked=false;}controls();});
  $('contest').addEventListener('change', loadCompetition);
  $('refresh').addEventListener('click', loadCompetition);
  $('format').addEventListener('click', () => { const expanded = $('format-body').hidden; $('format-body').hidden = !expanded; $('format').setAttribute('aria-expanded', String(expanded)); });
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
