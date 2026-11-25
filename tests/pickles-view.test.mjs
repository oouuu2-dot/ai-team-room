import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const render=html.slice(html.indexOf('  function msgHtml('),html.indexOf('  function renderAll('));
function fixture(mode=true,sender='피클3'){
 const context={pickleChat:mode,state:{sender,key:'test'},lastForGroup:null,kstDay:()=>'',kstTime:()=> '10:00',esc:s=>String(s).replaceAll('<','&lt;'),renderMd:s=>s,msgKind:m=>m.sender==='똑똑이'?'boss':''};
 return runInNewContext(html.match(/  function isPickleParticipant\(name\)\{[^\n]+/)[0]+render+'\n({isPickleParticipant,msgHtml})',context);
}
const message=(sender,extra={})=>({id:1,sender,content:'안녕하세요',created_at:'2026-11-25T00:00:00Z',...extra});
test('dedicated view includes only boss and Pickles 1–5, without changing room rendering',()=>{
 const f=fixture();
 for(const who of ['똑똑이','피클1','피클2','피클3','피클4','피클5']) assert.match(f.msgHtml(message(who),''),/안녕하세요/);
 for(const who of ['뮤즈','클로드','의장','피클6']) assert.equal(f.msgHtml(message(who),''),'');
 assert.match(fixture(false).msgHtml(message('뮤즈'),''),/뮤즈/);
});
test('own bubble follows selected identity and hidden participants do not leak through quotes',()=>{
 assert.match(fixture().msgHtml(message('피클3'),''),/class="msg mine"/);
 assert.doesNotMatch(fixture().msgHtml(message('피클1'),''),/class="msg mine"/);
 const hidden=fixture().msgHtml(message('피클1',{reply_to:{id:2,sender:'클로드',content:'숨긴 답글'}}),'');
 assert.doesNotMatch(hidden,/숨긴 답글|클로드/);
 assert.doesNotMatch(fixture().msgHtml(message('피클1',{content:'긴 글'.repeat(100)}),''),/content clamp/);
});
