/**
 * 入库模块的装配。
 * 边界：只注册「解析 → 切分 → 嵌入 → 落库」这条流水线（IngestionService、ParserService、TextParser），
 *      模型 provider（EMBEDDINGS_PROVIDER）与 EmbeddingsService 由全局的 LlmModule 提供，本模块不重复注册；
 *      消费方是 worker.module（在那里实例化 IngestionProcessor 拉起队列消费），API 进程只投递任务、不 import 本模块。
 * 说明：PdfParser / DocxParser 已在 B8 删除（B3 起 ParserService 内部直接用
 *      PDFLoader / DocxLoader），本模块的解析侧只剩 ParserService + TextParser。
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { LlmModule } from '../llm/llm.module';
import { IngestionService } from './ingestion.service';
import { ParserService } from './parsing/parser.service';
import { TextParser } from './parsing/text.parser';

@Module({
  imports: [DatabaseModule, StorageModule, LlmModule],
  // TextParser 仍要被注册：ParserService 注入它做 TXT/MD 的 GB18030 回退解码
  providers: [IngestionService, ParserService, TextParser],
  exports: [IngestionService, ParserService],
})
export class IngestionModule {}
