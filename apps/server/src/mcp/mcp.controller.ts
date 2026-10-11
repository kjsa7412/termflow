import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import { APP_NAME } from '@termflow/shared';
import { clientIp } from '../common/audit/audit.js';
import { UnauthorizedProblem } from '../common/problem/problem.exception.js';
import { callRoute } from './executor.js';
import { SERVER_INSTRUCTIONS, TABLE_DESIGN_PROMPT, tableDesignPromptText } from './instructions.js';
import { RouteCatalog, type RouteTool } from './route-catalog.js';

/** 프로토콜 서버 버전 표기(도구 목록이 바뀌는 판에서 올린다). */
const SERVER_VERSION = '1.0.0';

function annotations(t: RouteTool) {
  return {
    title: t.name,
    readOnlyHint: t.readOnly,
    destructiveHint: t.method === 'DELETE',
    idempotentHint: t.method === 'GET' || t.method === 'PUT' || t.method === 'DELETE',
    openWorldHint: false,
  };
}

/**
 * `/mcp` — 외부 에이전트 연동 엔드포인트(CR-18). Streamable HTTP **무상태** 모드: 요청마다 서버 인스턴스를 만들고
 * JSON으로 응답한다(세션 ID·SSE 없음). 접근 토큰(Bearer) 전용 — 세션 쿠키 요청은 401.
 * 도구 호출은 같은 서버의 REST를 같은 토큰으로 부른다(executor.ts).
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly catalog: RouteCatalog) {}

  private requireToken(req: Request, res: Response): void {
    if (!req.tokenAuth) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="termflow"');
      throw new UnauthorizedProblem('접근 토큰(Authorization: Bearer tfp_…)이 필요합니다');
    }
  }

  @Post()
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.requireToken(req, res);
    const user = req.authUser!;
    const tools = this.catalog.tools.filter((t) => !t.sysAdmin || user.isSysAdmin);
    const server = new Server(
      { name: APP_NAME.toLowerCase(), version: SERVER_VERSION },
      { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
        annotations: annotations(t),
      })),
    }));
    const ctx = {
      baseUrl: `http://127.0.0.1:${req.socket.localPort}`,
      authorization: req.get('authorization') ?? '',
      forwardedFor: clientIp(req),
    };
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const tool = tools.find((t) => t.name === r.params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `없는 도구: ${r.params.name}`);
      return callRoute(tool, r.params.arguments ?? {}, ctx);
    });
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [TABLE_DESIGN_PROMPT] }));
    server.setRequestHandler(GetPromptRequestSchema, (r) => {
      if (r.params.name !== TABLE_DESIGN_PROMPT.name) {
        throw new McpError(ErrorCode.InvalidParams, `없는 프롬프트: ${r.params.name}`);
      }
      return {
        description: TABLE_DESIGN_PROMPT.description,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: tableDesignPromptText(r.params.arguments ?? {}),
            },
          },
        ],
      };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** 무상태 모드라 서버 → 클라이언트 스트림(GET)·세션 종료(DELETE)는 없다. */
  @Get()
  @HttpCode(405)
  get(@Req() req: Request, @Res({ passthrough: true }) res: Response): object {
    this.requireToken(req, res);
    res.setHeader('Allow', 'POST');
    return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null };
  }

  @Delete()
  @HttpCode(405)
  remove(@Req() req: Request, @Res({ passthrough: true }) res: Response): object {
    return this.get(req, res);
  }
}
