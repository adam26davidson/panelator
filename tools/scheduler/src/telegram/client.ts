export interface TelegramMessage {message_id:number;date:number;chat:{id:number};text?:string;reply_to_message?:{message_id:number}}
export interface TelegramUpdate {update_id:number;message?:TelegramMessage;callback_query?:{id:string;data?:string;message?:TelegramMessage};edited_message?:TelegramMessage}
export interface Keyboard {inline_keyboard:{text:string;callback_data:string}[][]}
export interface SendMessage {text:string;reply_to_message_id?:number;reply_markup?:Keyboard}
export class TelegramApiError extends Error {
 error_code:number;description:string;
 constructor(error_code:number,description:string){super(`Telegram API ${error_code}: ${description}`);this.error_code=error_code;this.description=description;}
}
export const isAuthError=(e:unknown)=>e instanceof TelegramApiError&&[401,404].includes(e.error_code);
export class TelegramClient {
 private token:string;readonly chatId:number;private baseUrl:string;
 constructor(token:string,chatId:number,baseUrl='https://api.telegram.org'){this.token=token;this.chatId=chatId;this.baseUrl=baseUrl;}
 private async call<T>(method:string,body:object={},signal?:AbortSignal):Promise<T>{
  let response:Response;try{response=await fetch(`${this.baseUrl}/bot${this.token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});}catch{throw new TelegramApiError(0,'connection failed');}
  let data:{ok:boolean;result:T;error_code?:number;description?:string};try{data=await response.json() as typeof data;}catch{throw new TelegramApiError(response.status,'invalid response');}
  if(!response.ok||!data.ok)throw new TelegramApiError(data.error_code??response.status,(data.description??'request failed').split(this.token).join('[redacted]'));
  return data.result;
 }
 getMe(){return this.call<{id:number;username:string}>('getMe');}
 getUpdates(opts:{offset:number;timeout:number;allowed_updates?:string[];signal?:AbortSignal}){const {signal,...body}=opts;return this.call<TelegramUpdate[]>('getUpdates',{...body,allowed_updates:['message','callback_query']},signal);}
 async sendMessage(message:SendMessage){return (await this.call<TelegramMessage>('sendMessage',{chat_id:this.chatId,...message})).message_id;}
 editMessageReplyMarkup(message_id:number,reply_markup:Keyboard={inline_keyboard:[]}){return this.call('editMessageReplyMarkup',{chat_id:this.chatId,message_id,reply_markup});}
 answerCallbackQuery(callback_query_id:string){return this.call('answerCallbackQuery',{callback_query_id});}
}
