/**
 * 新建会话的请求体校验规则。全仓库只有一个消费方：chat.controller.ts 的 create 路由
 * （前端 ChatPage 不直接调它，会话是 WebSocket 问答时由 ChatService 顺手建的；
 * HTTP 这条链路由 test/conversations.e2e-spec.ts 覆盖）。
 * 职责：声明「body 里允许出现什么」——只有一个可选的 title；
 *      不做默认值、不做 trim、不做权限判断，那些都在 ChatService.createConversation 里。
 * 说明：全局 ValidationPipe 开了 whitelist（main.ts:35），所以 body 里多传的任何字段
 *      会在进控制器前被剥掉，本 DTO 没有字段可挂就等于「不接受」。
 */
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateConversationDto {
  /**
   * 会话标题，可缺省。三条装饰器叠加的实际语义：
   * - @IsOptional()：class-validator 的实现是「值为 null 或 undefined 时跳过后续所有校验」
   *   （node_modules/class-validator cjs/decorator/common/IsOptional.js:20 的判据），
   *   所以不传、传 undefined、显式传 null 都能通过；空串 "" 不属于「缺省」，会继续往下走。
   * - @IsString()：只有传了非 null 值才要求它是字符串，传数字 → 400。
   * - @Length(1, 80)：下限 1 会把 "" 拦成 400；上限 80 是接口侧唯一的长度闸门。
   *   这里不 trim：全空格「   」长度算 3，属合法输入，
   *   真正的兜底在服务层——ChatService.createConversation 用 `title?.trim() || '新对话'`
   *   把 trim 后为空串（含上面的 null 与全空格）统一收敛成默认标题。
   */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  title?: string;
}
