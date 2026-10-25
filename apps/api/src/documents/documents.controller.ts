/**
 * 文档相关的 HTTP 路由：只做「参数形状校验 + 声明守卫 + 转调 DocumentsService」，没有业务分支。
 *
 * 鉴权是两层的，而且覆盖面不一样（这点最容易读漏）：
 * - 类级 @UseGuards(OrgMemberGuard)：六条路由全都过，先确认 URL 里的 orgId 是请求者所属组织
 * - @UseGuards(KbPermissionGuard) + @RequireKbPermission(...)：只有 list 与 upload 两条挂上，
 *   因为只有这两条的路径里有 :kbId。剩下四条（chunks / download / remove / retry）路径里只有
 *   :documentId，KbPermissionGuard 拿不到库参数（它的实现是「orgId/kbId 任一缺失就 404」），
 *   门槛改由服务层用 KbAccessService.require 现判，实际等级是 viewer / viewer / editor / editor
 * - 所以「控制器上没写门槛」不等于「这条路由没门槛」；也别照抄这里的注解形状去改别处——
 *   同一份代码里 UseGuards 与 RequireKbPermission 必须成对出现，只挂守卫不贴装饰器等于放行
 *
 * 全局的 AuthGuard / Origin 守卫 / 限流 / 异常过滤都由 APP_GUARD、APP_FILTER 提供，不在这里重复。
 * 不做：不读文件内容、不拼磁盘路径、不判状态机、不组装响应体（除 download 必须自己写响应）。
 */
import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireKbPermission } from '../common/decorators/require-kb-permission.decorator';
import { KbPermissionGuard } from '../common/guards/kb-permission.guard';
import { OrgMemberGuard } from '../common/guards/org-member.guard';
import { AuthUser } from '../common/types';
import { DocumentsService } from './documents.service';

/** 类级守卫：六条路由都要求 orgId 是请求者自己的组织，非成员一律 404 */
@UseGuards(OrgMemberGuard)
@Controller('orgs/:orgId')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** 某知识库的文档列表；viewer 即可。服务层不再判权限，正是靠这一行装饰器 */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('viewer')
  @Get('knowledge-bases/:kbId/documents')
  list(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
  ) {
    return this.documents.list(orgId, kbId);
  }

  /**
   * 上传文档：editor 门槛（只读成员传不了）。
   * 体积有两道闸，单位与后果都不同：
   * - 这里 FileInterceptor 的 25MB 是写死的，不读 MAX_UPLOAD_MB。超限时 multer 的
   *   LIMIT_FILE_SIZE 被 Nest 转成 413 PayloadTooLarge，请求根本进不到 handler，
   *   文案是 multer 的英文 "File too large"（4xx 会被全局过滤器原样透出）
   * - 服务层 validateUpload 按 MAX_UPLOAD_MB（默认 20）判，报的是中文 400
   * 所以实际生效的是两者里较小的那个：配 20 时中文 400 先命中，配 30 时先被 25MB 那道拦成 413，
   * 把 MAX_UPLOAD_MB 配到 25 以上不会放宽任何东西。
   * FileInterceptor 默认内存存储：整个文件先完整缓冲进 file.buffer，上限判断也发生在进 handler 之前。
   * file 声明为可选——不带 file 字段时 multer 给 undefined，最终由 validateUpload 报 400「请选择要上传的文件」。
   */
  @UseGuards(KbPermissionGuard)
  @RequireKbPermission('editor')
  @Post('knowledge-bases/:kbId/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  upload(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // userId 取自会话而不是请求体：前端传谁不重要，入库任务里记录的作者以登录者为准
    return this.documents.upload({ userId: user.id, orgId, kbId, file });
  }

  /**
   * 查看分片。无 kbId 路径参数，所以这里只有类级 OrgMemberGuard；
   * viewer 判定在 DocumentsService.listChunks 里取到行的 kbId 之后进行。
   */
  @Get('documents/:documentId/chunks')
  chunks(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.listChunks(user.id, orgId, documentId);
  }

  /**
   * 下载原文件。带 @Res() 时 Nest 放弃自动序列化返回值，必须由 handler 自己写响应，
   * 所以这个方法是 async 且 return 了 res.download 的调用。
   * 服务返回的 absolutePath 已经过存储层的路径穿越校验（storageKey 来自数据库，不是用户输入）；
   * 第二个参数 filename 是浏览器「另存为」里的名字，用库里的乱码修复后写法。
   */
  @Get('documents/:documentId/download')
  async download(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    // 权限判定在服务层（viewer），先于任何磁盘访问
    const file = await this.documents.download(user.id, orgId, documentId);
    return res.download(file.absolutePath, file.filename);
  }

  /** 删除文档：只有 OrgMemberGuard 兜组织边界，editor 判定在 DocumentsService.remove */
  @Delete('documents/:documentId')
  remove(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.remove(user.id, orgId, documentId);
  }

  /** 重新入库：editor 判定在 DocumentsService.retry，那里还会挡住 processing 状态的并发重投 */
  @Post('documents/:documentId/retry')
  retry(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documents.retry(user.id, orgId, documentId);
  }
}
