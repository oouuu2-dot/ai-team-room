'use strict';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stages=['source','script','narration','render','done'],names=['소스','대본','나레이션','렌더','완성본'];
let key=localStorage.getItem('ai_team_room_key')||'',cards=[],current=null,selected=Number(new URLSearchParams(location.search).get('card'))||null,dirty=false,busy=false,polling=false,storage=false;
let mediaURLs=[];
let language='kr';
function status(t){$('#status').textContent=t;}
async function api(path='',method='GET',body){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
 try{const r=await fetch('/api/shorts-workroom'+path,{method,signal:controller.signal,headers:{'Authorization':'Bearer '+key,...(body instanceof Blob?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:body instanceof Blob?body:JSON.stringify(body)})});
 const d=await r.json();if(!r.ok){if(r.status===401)$('#connect').showModal();throw Error(d.error||'연결 실패');}return d;}finally{clearTimeout(timer);}
}
function releaseMedia(){for(const u of mediaURLs)URL.revokeObjectURL(u);mediaURLs=[];}
function field(id,label,value='',rows=false){return `<label>${label}${rows?`<textarea id="${id}">${esc(value)}</textarea>`:`<input id="${id}" value="${esc(value)}">`}</label>`;}
function btn(action,label,sub=false){return `<button data-action="${action}"${sub?' class="subtle"':''}>${label}</button>`;}
function step(i,html){return `<details ${stages.indexOf(current.stage)===i?'open':''}><summary>${stages.indexOf(current.stage)>i?'✓ ':''}${i+1}. ${names[i]}</summary>${html}</details>`;}
function drawCards(){ $('#cards').innerHTML=cards.map(c=>`<button class="card ${c.id===selected?'active':''} ${c.archived?'archived':''}" data-card="${c.id}"><b>${c.id}. ${esc(c.product)}</b> <i class="badge">${names[stages.indexOf(c.stage)]}</i><span>한 ${esc(c.littly_kr||'미정')} · 일 ${esc(c.littly_jp||'미정')} · ${esc(c.assignee)}${c.archived?' · 보관':''}</span></button>`).join('')||'<p>첫 카드를 만들어 주세요.</p>';}
function uploadField(slot,label){const f=current.files[slot];return `<label>${label}<input type="file" data-slot="${slot}" ${!storage?'disabled':''} ${slot.startsWith('video')||slot==='source'?'accept="video/*"':slot.startsWith('narration')?'accept="audio/*"':slot.startsWith('thumbnail')?'accept="image/*"':''}></label><p class="muted">${f?`${esc(f.name)} · ${(f.size/1048576).toFixed(1)}MB · ${f.synced?'✓ PC 저장됨':'PC 저장 대기'}`:'파일을 선택하거나 끌어 놓으세요 · 최대 500MB'}</p>${f?`<div data-media="${slot}"></div>`:''}`;}
function drawDetail(){releaseMedia();dirty=false;const c=current;if(!c){$('#detail').innerHTML='<p>카드를 선택해 주세요.</p>';$('#turn').textContent='진행할 카드를 만들어 주세요';return;}
 $('#turn').textContent=`지금 차례: ${c.assignee} · ${names[stages.indexOf(c.stage)]}`;
 let source=`<div id="sources">${c.sources.map((s,i)=>`<div class="source" data-source="${i}"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">소스 ${i+1} 열기</a><p>${esc(s.url)}</p><label><input type="radio" name="mainSource" value="${i}" ${s.main?'checked':''}> 메인</label><select data-review><option value="pending" ${s.review==='pending'?'selected':''}>검수 대기</option><option value="pass" ${s.review==='pass'?'selected':''}>통과</option><option value="fail" ${s.review==='fail'?'selected':''}>탈락</option></select><input data-quality placeholder="최대 화질 · 자막/워터마크 · 장면 · 같은 제품" value="${esc(s.quality)}"><input data-reason placeholder="검수 이유" value="${esc(s.reason)}"></div>`).join('')}</div>`;
 source=field('product','제품명',c.product)+btn('save_product','제품명 저장',true)+source;
 source+=field('sourceUrl','소스 링크 추가')+`<div class="actions">${btn('add_source','링크 추가',true)}${btn('save_source','검수 저장',true)}${btn('confirm_source','소스 확정')}</div>`;
 let script='<div class="columns">'+['kr','jp'].map(l=>`<section><h3>${l==='kr'?'한국어':'일본어'}</h3>${field('draft_'+l,'피클 초안',c.script['draft_'+l],true)}${field('final_'+l,'클로드 최종본',c.script['final_'+l],true)}<p class="muted">${c.script['final_'+l].length}자 · 예상 길이는 실제 녹음으로 확인</p></section>`).join('')+'</div>';
 script+=`<div class="actions">${btn('save_script','대본 저장',true)}${btn('submit_draft','초안 → 클로드 검수')}${btn('submit_final','최종본 → 대표 확인')}${btn('confirm_script','대본 확정')}</div><p class="muted">${c.script.pc_synced?'✓ 대본 PC 저장됨':'대본 확정 후 PC 동기화 대기'}</p>`;
 let narration=field('littly_kr','한국 리틀리 번호',c.littly_kr)+field('littly_jp','일본 리틀리 번호',c.littly_jp)+btn('save_numbers','번호 저장',true)+uploadField('source','소스 영상')+'<div class="columns">'+uploadField('narration_kr','한국어 나레이션')+uploadField('narration_jp','일본어 나레이션')+'</div><p>세 파일·번호·확정 대본이 PC에 저장되면 렌더 단계로 넘어갑니다.</p>';
 let render=`<p>현재: <b>${esc(c.render_status)}</b></p><select id="renderStatus">${['대기','렌더 중','검수 중'].map(v=>`<option ${c.render_status===v?'selected':''}>${v}</option>`).join('')}</select>${btn('save_render','상태 저장',true)}<div class="columns">${uploadField('video_kr','한국 완성본')}${uploadField('video_jp','일본 완성본')}</div><div class="columns">${uploadField('thumbnail_kr','한국 썸네일')}${uploadField('thumbnail_jp','일본 썸네일')}</div>${btn('complete_render','검수 완료 → 완성본')}`;
 let outputs='<div class="columns">'+['kr','jp'].map(l=>`<section><h3>${l==='kr'?'한국':'일본'}</h3><div data-media="video_${l}"></div><div data-media="thumbnail_${l}"></div>${[['title','유튜브 제목'],['description','설명'],['pinned','고정댓글'],['caption','인스타 캡션'],['hashtags','해시태그'],['comment','첫 댓글'],['keyword','키워드']].map(([k,t])=>field(k+'_'+l,t,c.outputs[k+'_'+l],true)+`<button class="subtle" data-copy="${k+'_'+l}">복사</button>`).join('')}</section>`).join('')+'</div><div class="actions">'+btn('save_outputs','업로드 문구 저장',true)+btn('archive','업로드 완료 · 보관')+'</div><p class="muted">이 버튼은 보관만 합니다. 실제 게시·예약은 대표가 진행합니다.</p>';
 $('#detail').innerHTML=`<section class="hero"><h2>${c.id}. ${esc(c.product)}</h2><ol class="steps">${stages.map((s,i)=>`<li class="${i<stages.indexOf(c.stage)?'past':s===c.stage?'now':''}">${i+1} ${names[i]}</li>`).join('')}</ol></section>`+step(0,source)+step(1,script)+step(2,narration)+step(3,render)+step(4,outputs)+`<section class="panel"><h3>카드 메모</h3>${field('note','메모 / 다시 만들기 요청','',true)}<div class="actions">${btn('note','메모 남기기',true)}${btn('rewind','이전 단계로 다시',true)}</div>${c.log.slice().reverse().map(l=>`<div class="log"><b>${esc(l.actor)}</b> · ${esc(l.at)}\n${esc(l.text)}</div>`).join('')}</section>`;
 // Disabled completed/future step inputs prevent accidental edits; server also validates stage.
 document.querySelectorAll('details').forEach((el,i)=>{if(i!==stages.indexOf(c.stage))el.querySelectorAll('input,textarea,select,button').forEach(x=>x.disabled=true);});
 for(const index of [1,4]){
  const panel=document.querySelectorAll('details')[index],cols=panel.querySelector('.columns');
  cols.insertAdjacentHTML('beforebegin','<nav class="actions"><button type="button" class="subtle" data-language="kr">한국어</button><button type="button" class="subtle" data-language="jp">일본어</button></nav>');
  [...cols.children].forEach((section,i)=>{section.dataset.lang=i?'jp':'kr';section.hidden=section.dataset.lang!==language;});
 }
 for(const l of ['kr','jp']){
  const old=new Set(c.script['draft_'+l].split('\n')),lines=c.script['final_'+l].split('\n');
  $('#final_'+l).parentElement.insertAdjacentHTML('beforeend','<small>초안에서 바뀐 줄</small><pre class="diff">'+lines.map(line=>old.has(line)?esc(line):'<mark>'+esc(line)+'</mark>').join('\n')+'</pre>');
 }
 loadMedia();
}
async function loadMedia(){for(const el of document.querySelectorAll('[data-media]')){const slot=el.dataset.media,f=current.files[slot];if(!f)continue;
 // Large videos use native streaming via short-lived object-scoped tickets, never room keys in URLs.
 if(/^(video|audio)\//.test(f.mime)){try{const d=await api(`/${current.id}/files/${f.id}/ticket`,'POST',{});if(!el.isConnected)return;const tag=f.mime.startsWith('video')?'video':'audio';el.innerHTML=`<${tag} controls preload="none" src="${esc(d.url)}"></${tag}>`;}catch(e){el.textContent='미리보기: '+e.message;} }
 else if(f.mime.startsWith('image/')){try{const d=await api(`/${current.id}/files/${f.id}/ticket`,'POST',{});if(el.isConnected)el.innerHTML=`<img loading="lazy" src="${esc(d.url)}" alt="썸네일">`;}catch(e){el.textContent=e.message;}}
 }}
async function refresh(force=false){if(polling||busy||(!force&&dirty))return;polling=true;try{const d=await api();cards=d.cards;storage=d.storage_ready;$('#storage').hidden=storage;if(!selected&&cards.length)selected=cards[0].id;drawCards();const c=cards.find(c=>c.id===selected);if(force||c?.version!==current?.version||c?.id!==current?.id){current=c||null;drawDetail();}}catch(e){status(e.message);}finally{polling=false;}}
async function mutate(action,extra={}){const d=await api('/'+current.id,'PATCH',{action,actor:$('#actor').value,version:current.version,...extra});current=d.card;dirty=false;await refresh(true);status('저장했습니다.');}
function sourceValues(){return current.sources.map((s,i)=>{const el=document.querySelector(`[data-source="${i}"]`);return {...s,main:document.querySelector('[name=mainSource]:checked')?.value===String(i),review:el.querySelector('[data-review]').value,quality:el.querySelector('[data-quality]').value,reason:el.querySelector('[data-reason]').value};});}
async function action(a){if(busy)return;busy=true;status('저장 중…');try{
 if(a==='confirm_source'&&dirty)await mutate('save',{sources:sourceValues()});
 if(['submit_draft','submit_final','confirm_script'].includes(a)&&dirty)await mutate('save',{script:Object.fromEntries(['draft_kr','draft_jp','final_kr','final_jp'].map(k=>[k,$('#'+k).value]))});
 if(a==='add_source'){const url=$('#sourceUrl').value.trim();await mutate('save',{sources:[...sourceValues(),{url,review:'pending'}]});}
 else if(a==='save_source')await mutate('save',{sources:sourceValues()});
 else if(a==='save_product')await mutate('save',{product:$('#product').value});
 else if(a==='save_script')await mutate('save',{script:Object.fromEntries(['draft_kr','draft_jp','final_kr','final_jp'].map(k=>[k,$('#'+k).value]))});
 else if(a==='save_numbers')await mutate('save',{littly_kr:$('#littly_kr').value,littly_jp:$('#littly_jp').value});
 else if(a==='save_render')await mutate('save',{render_status:$('#renderStatus').value});
 else if(a==='save_outputs'){const values={};for(const k of ['title','description','pinned','caption','hashtags','comment','keyword'])for(const l of ['kr','jp'])values[k+'_'+l]=$('#'+k+'_'+l).value;await mutate('save',{outputs:values});}
 else if(a==='note')await mutate('save',{note:$('#note').value});
 else if(a==='rewind'){if(confirm('이전 단계로 돌아가 수정할까요?'))await mutate(a,{note:$('#note').value});}
 else await mutate(a);
 }catch(e){status(e.message==='version_conflict_reload'?'다른 담당자가 수정했습니다. 작성 내용을 복사해 둔 뒤 새로고침해 주세요.':e.message);}finally{busy=false;if(!dirty)await refresh(true);}}
async function upload(input){if(busy)return;const f=input.files[0];if(!f)return;if(f.size>500*1048576){status('최대 500MB입니다.');return;}if(dirty){status('작성 중인 내용을 먼저 저장해 주세요.');return;}
 busy=true;const cardId=current.id;try{const d=await api(`/${cardId}/files`,'POST',{slot:input.dataset.slot,name:f.name,mime:f.type,size:f.size});for(let offset=0,n=1;offset<f.size;offset+=d.part_size,n++){status(`${f.name} · ${Math.floor(offset/f.size*100)}% 업로드`);await api(`/${cardId}/files/${d.id}/part?number=${n}`,'POST',f.slice(offset,offset+d.part_size));}await api(`/${cardId}/files/${d.id}/complete`,'POST',{});dirty=false;status('업로드 완료 · PC 동기화를 기다립니다.');}catch(e){status(e.message);}finally{busy=false;await refresh(true);}}
$('#detail').addEventListener('input',e=>{if(e.target.type==='file')return;dirty=true;status('저장하지 않은 변경 사항이 있습니다.');});
$('#detail').addEventListener('change',e=>{if(e.target.matches('[data-slot]'))upload(e.target);});
$('#detail').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.language){language=b.dataset.language;document.querySelectorAll('[data-lang]').forEach(el=>el.hidden=el.dataset.lang!==language);return;}if(b.dataset.copy){navigator.clipboard.writeText($('#'+b.dataset.copy).value).then(()=>status('복사했습니다.')).catch(()=>status('텍스트를 선택해 복사해 주세요.'));return;}if(b.dataset.action)action(b.dataset.action);});
$('#cards').addEventListener('click',e=>{const b=e.target.closest('[data-card]');if(!b||busy)return;if(dirty&&!confirm('저장하지 않은 변경 사항을 버릴까요?'))return;selected=Number(b.dataset.card);dirty=false;refresh(true);});
$('#new').onclick=()=>{if(busy)return;$('#newProduct').value='';$('#createCard').showModal();};
$('#cancelCreate').onclick=()=>$('#createCard').close();
$('#createForm').onsubmit=async e=>{e.preventDefault();const product=$('#newProduct').value.trim();if(!product||busy)return;busy=true;try{const d=await api('','POST',{product,actor:$('#actor').value});selected=d.card.id;dirty=false;$('#createCard').close();}catch(e){status(e.message);}finally{busy=false;await refresh(true);}};
$('#keyBtn').onclick=()=>$('#connect').showModal();$('#connect').addEventListener('close',()=>{if($('#connect').returnValue==='connect'){key=$('#roomKey').value;$('#roomKey').value='';localStorage.setItem('ai_team_room_key',key);refresh(true);}});
window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
setInterval(()=>{if(!document.hidden)refresh();},10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});if(key)refresh(true);else $('#connect').showModal();
