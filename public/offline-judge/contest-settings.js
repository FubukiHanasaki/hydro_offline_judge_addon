/* Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later. */
(() => {
 'use strict';
 const section=document.getElementById('offline-contest-settings');if(!section)return;
 const form=document.querySelector('form[method="post"]');if(!form)return;
 form.closest('.section').after(section);section.hidden=false;
 const rows=document.getElementById('offline-settings-rows'),save=document.getElementById('offline-settings-save'),notice=document.getElementById('offline-settings-notice');let version=0;
 function el(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
 function report(message,error=false){notice.textContent=message;notice.hidden=!message;notice.className=error?'oj-error':'';}
 async function api(body){const r=await fetch(section.dataset.api,{credentials:'same-origin',cache:'no-store',method:body?'POST':'GET',headers:{Accept:'application/json','Content-Type':'application/json','X-Offline-Judge':'1'},...body?{body:JSON.stringify(body)}:{}});const value=await r.json();if(!r.ok)throw Error(value.message||value.error?.message||'设置读取失败');return value.data;}
 function draw(data){version=data.version;rows.replaceChildren();
  for(const p of data.problems){const row=el('tr');row.dataset.pid=p.pid;row.append(el('td',`${p.label} · ${p.title}`));
   const name=el('input');name.className='textbox';name.dataset.name='';name.value=p.name;name.maxLength=64;name.placeholder='例如 tree';name.setAttribute('aria-label',p.title+' 题目英文名');const cell=el('td');cell.append(name);row.append(cell);
   const io=el('select');io.className='select';io.dataset.io='';io.setAttribute('aria-label',p.title+' 输入输出');for(const [value,label]of [['inherit','沿用原题'],['stdio','标准输入输出'],['file','文件输入输出']]){const o=el('option',label);o.value=value;o.disabled=value==='stdio'&&!!p.originalFilename;io.append(o);}io.value=p.io;io.disabled=data.ioLocked;
   const file=el('input');file.className='textbox';file.dataset.filename='';file.maxLength=64;file.value=p.filename;file.placeholder='例如 tree（不含扩展名）';file.setAttribute('aria-label',p.title+' 文件名');
   function sync(){file.hidden=io.value!=='file'||data.ioLocked;file.disabled=data.ioLocked;file.required=io.value==='file';}io.addEventListener('change',()=>{if(io.value==='file'&&!file.value)file.value=p.originalFilename||name.value;sync();});sync();
   const mode=el('td'),filename=el('td');mode.append(io);filename.append(file);if(data.ioLocked&&p.io==='file')filename.append(el('span',`${p.filename}.in / ${p.filename}.out`));row.append(mode,filename);[...row.children].forEach((cell,i)=>{cell.dataset.label=['','题目英文名','输入输出','文件名'][i];if(i===3&&io.value!=='file')cell.hidden=true;});io.addEventListener('change',()=>{filename.hidden=io.value!=='file';});rows.append(row);
  }
 }
 save.addEventListener('click',async()=>{const problems=Object.create(null);for(const row of rows.children){const name=row.querySelector('[data-name]'),io=row.querySelector('[data-io]'),file=row.querySelector('[data-filename]');if(io.value==='file'&&!file.value.trim()){report('请填写文件名，例如 tree',true);file.focus();return;}problems[row.dataset.pid]={name:name.value,io:io.value,filename:file.value};}save.disabled=true;report('');try{draw(await api({version,problems}));report('代码包与 IO 设置已保存');}catch(error){report(error.message,true);}finally{save.disabled=false;}});
 save.disabled=true;api().then(data=>{draw(data);if(data.ioLocked)report('已有提交，IO 设置已锁定');save.disabled=false;}).catch(error=>report(error.message,true));
})();
