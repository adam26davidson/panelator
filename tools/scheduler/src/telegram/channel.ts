import type {PausedRecord} from '../state/paused.ts';
import {questionMessage} from './questions.ts';
import {TelegramClient,type Keyboard,type SendMessage} from './client.ts';
export interface TelegramChannel {
 client:TelegramClient;
 sendQuestion(record:PausedRecord,title:string,url:string):Promise<number>;
 sendReply(text:string,replyTo?:number,markup?:Keyboard):Promise<number>;
 replaceKeyboard(messageId:number,markup?:Keyboard):Promise<unknown>;
 answerCallback(id:string):Promise<unknown>;
}
export function telegramChannel(client:TelegramClient):TelegramChannel{return {
 client,sendQuestion:(r,title,url)=>client.sendMessage({...questionMessage({number:r.issue,title},r,url),...(r.telegram?.thread_last_message_id?{reply_to_message_id:r.telegram.thread_last_message_id}:{})}),
 sendReply:(text,reply_to_message_id,reply_markup)=>client.sendMessage({text,reply_to_message_id,reply_markup} satisfies SendMessage),
 replaceKeyboard:(id,markup)=>client.editMessageReplyMarkup(id,markup),answerCallback:id=>client.answerCallbackQuery(id),
};}
