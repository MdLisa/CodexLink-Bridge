import {parentPort,workerData} from 'node:worker_threads';
import {Unzip,UnzipInflate} from 'fflate';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {DOCUMENT_TEXT_LIMIT} from './chat-documents.mjs';

const fail=message=>{throw Error(message);};
const decode=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('文本编码无法识别，请另存为 UTF-8 后重试。');}};
function bounded(text){if(text.length>DOCUMENT_TEXT_LIMIT)fail('提取内容超过 10 万字符，请拆分文件后重试。');return text;}
function xml(bytes){const text=decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)fail('Office 文件 XML 无效，不支持实体声明。');return new XMLParser({preserveOrder:true,ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,trimValues:false,processEntities:true}).parse(text);}
function nodes(tree,tag){const found=[];function walk(items){for(const node of items||[])for(const [key,value]of Object.entries(node)){if(key===tag)found.push({children:value,attrs:node[':@']||{}});if(Array.isArray(value))walk(value);}}walk(tree);return found;}
function plain(tree){let result='';function walk(items){for(const node of items||[])for(const [tag,value]of Object.entries(node)){if(tag==='#text')result+=value;else if(Array.isArray(value)){walk(value);if(/^(p|row|br|tab)$/.test(tag))result+='\n';}bounded(result);}}walk(tree);return result;}
function office(body,ext){
 const entries=new Map();let count=0,total=0;
 const wanted=name=>ext==='docx'?/^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name):ext==='xlsx'?/^xl\/(sharedStrings|workbook|worksheets\/sheet\d+)\.xml$/.test(name):/^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name);
 const unzip=new Unzip(file=>{
  if(++count>2000)fail('Office 文件包含过多条目，请拆分后重试。');
  if(!wanted(file.name))return;
  if(entries.has(file.name)||file.originalSize>16*1024*1024)fail('Office 文件内容过大或条目重复。');
  const chunks=[];let size=0;
  entries.set(file.name,null);
  file.ondata=(error,chunk,final)=>{if(error)fail('Office 文件压缩内容损坏。');size+=chunk.length;total+=chunk.length;if(size>16*1024*1024||total>24*1024*1024)fail('Office 文件展开后过大，请拆分后重试。');chunks.push(Buffer.from(chunk));if(final)entries.set(file.name,Buffer.concat(chunks));};file.start();
 });
 unzip.register(UnzipInflate);
 for(let offset=0;offset<body.length;offset+=1024)unzip.push(body.subarray(offset,offset+1024),offset+1024>=body.length);
 if([...entries.values()].some(v=>v===null))fail('Office 文件压缩内容不完整。');
 let text='',hasContent=false;
 if(ext==='xlsx'){
  if(!entries.has('xl/workbook.xml'))fail('这不是有效的 XLSX 文件。');
  const shared=entries.has('xl/sharedStrings.xml')?nodes(xml(entries.get('xl/sharedStrings.xml')),'si').map(n=>plain(n.children)):[];
  const sheets=[...entries.keys()].filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  for(const sheet of sheets){text+='\n['+sheet.split('/').at(-1)+']\n';for(const row of nodes(xml(entries.get(sheet)),'row')){const cells=nodes(row.children,'c').map(c=>{let value=plain(nodes(c.children,'v')[0]?.children||[]);if(c.attrs['@_t']==='s')value=shared[Number(value)]??'';if(c.attrs['@_t']==='inlineStr')value=plain(nodes(c.children,'is')[0]?.children||[]);if(value.trim())hasContent=true;return(c.attrs['@_r']||'')+': '+value;});text+=cells.join('\t')+'\n';bounded(text);}}
 }else{
  const primary=ext==='docx'?'word/document.xml':'ppt/slides/slide1.xml';if(!entries.has(primary))fail('Office 文件内容缺失或格式不符。');
  for(const name of [...entries.keys()].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))){const value=plain(xml(entries.get(name)));if(value.trim())hasContent=true;text+='\n['+name.split('/').at(-1)+']\n'+value;bounded(text);}
 }
 if(!hasContent)fail('Office 文件没有可提取文字，请将图片内容作为图片发送。');
 return bounded(text);
}
async function extract(name,bytes){
 const body=Buffer.from(bytes);if(!body.length||body.length>10*1024*1024)fail('文件为空或超过 10 MB。');
 const ext=name.split('.').at(-1).toLowerCase();
 if(body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||body[0]===255&&body[1]===216&&body[2]===255||body.toString('ascii',0,4)==='RIFF'&&body.toString('ascii',8,12)==='WEBP'||/^GIF8[79]a$/.test(body.toString('ascii',0,6)))return{image:true};
 let text;
 if(['txt','md','markdown','csv','tsv','json','log','yaml','yml','xml','html','htm'].includes(ext)){
  const bom=body[0]===255&&body[1]===254;
  text=bom?new TextDecoder('utf-16le',{fatal:true}).decode(body.subarray(2)):decode(body);
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))fail('文件包含非文本内容，请转换为支持的文档格式。');
 }else if(ext==='pdf'){
  if(!body.subarray(0,5).equals(Buffer.from('%PDF-')))fail('文件内容不是有效的 PDF。');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(body),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,verbosity:0});
  let pdf;try{pdf=await task.promise;if(pdf.numPages>100)fail('PDF 超过 100 页，请拆分后重试。');text='';for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),content=await page.getTextContent();const value=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('');if(!value.trim())fail('PDF 第 '+i+' 页没有可提取文字，扫描页请转成图片发送。');text+='\n[第 '+i+' 页]\n'+value;bounded(text);page.cleanup();}}finally{await task.destroy();}
 }else if(['docx','xlsx','pptx'].includes(ext)){text=office(body,ext);}
 else fail('仅聊天支持文本、PDF、DOCX、XLSX、PPTX 和图片；请转换此文件格式。');
 if(!text?.trim())fail('未提取到文字；扫描文档请转成图片发送，加密文档请先解除密码。');
 return{text:bounded(text)};
}
try{parentPort.postMessage({result:await extract(workerData.name,workerData.body)});}catch(e){parentPort.postMessage({error:e.name==='PasswordException'?'PDF 已加密，请解除密码后上传。':e.message?.includes('PDF')||e.message?.includes('文件')||e.message?.includes('文本')||e.message?.includes('Office')||e.message?.includes('字符')||e.message?.includes('文字')||e.message?.includes('仅聊天')?e.message:'文件无法解析，请确认文件完整或转换格式后重试。'});}
