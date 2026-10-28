import {createServer} from 'node:http';
import type {TelegramUpdate} from '../../src/telegram/client.ts';
export async function fakeTelegram(){
 const requests:{method:string;body:Record<string,unknown>}[]=[];const sent:Record<string,unknown>[]=[];const edits:unknown[]=[];const answeredCallbacks:unknown[]=[];const updates:TelegramUpdate[]=[];const failures=new Map<string,number>();let flush:(()=>void)|undefined;
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');const method=req.url!.split('/').pop()!;requests.push({method,body});const reply=(result:unknown)=>{if(!res.destroyed)res.end(JSON.stringify({ok:true,result}));};const failure=failures.get(method);if(failure){failures.delete(method);res.statusCode=failure;res.end(JSON.stringify({ok:false,error_code:failure,description:'test error'}));return;}
 if(method==='getMe')reply({id:1,username:'test_bot'});
 else if(method==='sendMessage'){const message_id=sent.length+1;sent.push({...body,message_id});reply({message_id});}
 else if(method==='editMessageReplyMarkup'){edits.push(body);reply(true);}
 else if(method==='answerCallbackQuery'){answeredCallbacks.push(body);reply(true);}
 else if(method==='getUpdates'){const finish=()=>{const available=updates.filter(u=>u.update_id>=Number(body.offset??0));if(available.length){clearTimeout(timer);flush=undefined;reply(available);}};const timer=setTimeout(()=>{flush=undefined;reply([]);},Number(body.timeout)*1000);flush=finish;res.on('close',()=>{clearTimeout(timer);if(flush===finish)flush=undefined;});finish();}
 else reply(true);
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address() as {port:number};
 return {url:`http://127.0.0.1:${addr.port}`,requests,sent,edits,answeredCallbacks,push:(u:TelegramUpdate)=>{updates.push(u);flush?.();},fail:(method:string,code:number)=>failures.set(method,code),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
