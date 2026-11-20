import test from 'node:test';
import assert from 'node:assert/strict';
import { pmToUniver } from '../src/features/workspace/lib/pmToUniver.ts';
import { univerToHtml } from '../src/features/workspace/lib/univerHtml.ts';
const p = (text, ps) => ({type:'paragraph',attrs:{ps},content:[{type:'text',text}]});
const li = (...content) => ({type:'listItem',content});
const list = (type, content, start=1) => ({type,attrs:{start},content});
const save = (content, base={}) => pmToUniver({type:'doc',content},base);
test('changed list type wins over imported list definitions',()=>{
 const result=save([list('orderedList',[li(p('one',{__list:'old'}))])],{lists:{old:{listType:'BULLET_LIST'},'shar-list-1':{listType:'BULLET_LIST'}}});
 assert.match(univerToHtml(result),/^<ol/);
});
test('ordered start and adjacent independent lists survive save and reopen',()=>{
 const result=save([list('orderedList',[li(p('five')),li(p('six'))],5),list('orderedList',[li(p('new'))],1)]);
 const html=univerToHtml(result);
 assert.equal((html.match(/<ol/g)||[]).length,2);
 assert.match(html,/<ol start="5">/);
 assert.match(html,/<ol start="1">/);
});
test('mixed nested lists keep type, level and their own starting number',()=>{
 const result=save([list('bulletList',[li(p('parent'),list('orderedList',[li(p('child'))],3)),li(p('next'))])]);
 const html=univerToHtml(result);
 assert.match(html,/<ul><li><p>parent<\/p><ol start="3"><li><p>child<\/p><\/li><\/ol><\/li><li><p>next/);
});
test('splitting imported paragraphs never duplicates paragraph identifiers',()=>{
 const result=save([p('a',{__id:'imported'}),p('b',{__id:'imported'}),p('c',{__id:'imported'})]);
 const ids=result.body.paragraphs.map(p=>p.paragraphId);
 assert.equal(ids[0],'imported');assert.equal(new Set(ids).size,3);
});
test('checked state survives a checklist roundtrip',()=>{
 const result=save([list('taskList',[{type:'taskItem',attrs:{checked:true},content:[p('done')]}])]);
 assert.match(univerToHtml(result),/data-checked="true"/);
});
