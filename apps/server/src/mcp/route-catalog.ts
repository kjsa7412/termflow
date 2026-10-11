import { Injectable, ParseIntPipe, RequestMethod, type OnModuleInit } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { DiscoveryService } from '@nestjs/core';
import { API_PREFIX, type MemberRole } from '@termflow/shared';
import { z } from 'zod';
import { IS_PUBLIC, PROJECT_READ_ONLY_POST, PROJECT_ROLE } from '../auth/decorators.js';
import { SysAdminGuard } from '../auth/guards/sys-admin.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { TOOL_SPECS, type ToolSpec } from './tool-specs.js';

type JsonSchema = Record<string, unknown>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** REST 라우트 하나 = 외부 연동 도구 하나(CR-18 C5). */
export interface RouteTool {
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  /** `/api/v1/projects/:projectKey/...` */
  path: string;
  pathParams: string[];
  sysAdmin: boolean;
  role: MemberRole | null;
  readOnly: boolean;
  inputSchema: JsonSchema;
}

export interface CatalogScan {
  tools: RouteTool[];
  /** TOOL_SPECS에 이름도 제외 사유도 없는 라우트(테스트가 0건을 확인). */
  missing: string[];
  /** TOOL_SPECS에만 있고 라우트가 없는 키. */
  stale: string[];
}

const METHODS: Partial<Record<RequestMethod, HttpMethod>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
};

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

const PATH_PARAM_SCHEMA: Record<string, JsonSchema> = {
  projectKey: {
    type: 'string',
    pattern: '^[A-Z][A-Z0-9]{1,9}$',
    description: '프로젝트 키(예 RMS)',
  },
  key: { type: 'string', pattern: '^[A-Z][A-Z0-9]{1,9}$', description: '프로젝트·템플릿 키' },
  kind: { type: 'string', description: '표준 종류' },
};

function joinPath(...parts: (string | undefined)[]): string {
  const p = parts
    .flatMap((s) => (s ?? '').split('/'))
    .filter((s) => s !== '')
    .join('/');
  return `/${p}`;
}

function zodSchemaOf(arg: RouteArg | undefined): z.ZodType | null {
  for (const p of arg?.pipes ?? [])
    if (p instanceof ZodValidationPipe) return p.schema as z.ZodType;
  return null;
}

/** zod → 도구 입력 JSON Schema(입력 형태, 기본값이 있는 필드는 생략 가능). */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete out['$schema'];
  return out;
}

/** 컨트롤러 프로토타입의 메서드 이름(상속 포함, constructor 제외). */
function handlerNames(proto: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) {
      if (n !== 'constructor' && typeof (p as Record<string, unknown>)[n] === 'function') {
        names.add(n);
      }
    }
  }
  return [...names];
}

function isIntPipe(arg: RouteArg | undefined): boolean {
  return (arg?.pipes ?? []).some((p) => p === ParseIntPipe || p instanceof ParseIntPipe);
}

/**
 * 컨트롤러 메타데이터에서 REST 라우트를 모아 도구 목록을 만든다(기동 시 1회).
 * 라우트·권한·zod 스키마가 바뀌면 도구도 함께 바뀐다 — 손으로 맞출 것은 tool-specs.ts의 이름·설명뿐.
 */
@Injectable()
export class RouteCatalog implements OnModuleInit {
  private scan: CatalogScan = { tools: [], missing: [], stale: [] };

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    this.scan = this.build();
  }

  get tools(): RouteTool[] {
    return this.scan.tools;
  }

  result(): CatalogScan {
    return this.scan;
  }

  find(name: string): RouteTool | undefined {
    return this.scan.tools.find((t) => t.name === name);
  }

  private build(): CatalogScan {
    const tools: RouteTool[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
      const instance = wrapper.instance as object | undefined;
      if (!metatype || !instance) continue;
      const classPath = Reflect.getMetadata(PATH_METADATA, metatype) as
        string | string[] | undefined;
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const methodName of handlerNames(proto)) {
        const handler = proto[methodName] as object;
        const reqMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (reqMethod === undefined || methodPath === undefined) continue;
        const key = `${metatype.name}.${methodName}`;
        seen.add(key);
        const spec = TOOL_SPECS[key];
        if (!spec) {
          missing.push(key);
          continue;
        }
        if ('exclude' in spec) continue;
        const method = METHODS[reqMethod];
        if (!method) {
          missing.push(`${key}(지원하지 않는 메서드)`);
          continue;
        }
        tools.push(
          this.toTool(key, spec, method, metatype, methodName, handler, classPath, methodPath),
        );
      }
    }
    const stale = Object.keys(TOOL_SPECS).filter((k) => !seen.has(k));
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, missing, stale };
  }

  private toTool(
    key: string,
    spec: ToolSpec,
    method: HttpMethod,
    metatype: new (...a: unknown[]) => unknown,
    methodName: string,
    handler: object,
    classPath: string | string[] | undefined,
    methodPath: string,
  ): RouteTool {
    const cp = Array.isArray(classPath) ? classPath[0] : classPath;
    const path = joinPath(API_PREFIX, cp, methodPath);
    const pathParams = [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);

    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, methodName) ?? {}) as Record<
      string,
      RouteArg
    >;
    const byType = (t: RouteParamtypes) =>
      Object.entries(args)
        .filter(([k]) => k.split(':')[0] === String(t))
        .map(([, v]) => v);
    const body = zodSchemaOf(byType(RouteParamtypes.BODY)[0]);
    const query = zodSchemaOf(byType(RouteParamtypes.QUERY)[0]);
    const params = byType(RouteParamtypes.PARAM);

    const properties: Record<string, JsonSchema> = {};
    for (const p of pathParams) {
      const arg = params.find((a) => a.data === p);
      properties[p] =
        PATH_PARAM_SCHEMA[p] ??
        (isIntPipe(arg)
          ? { type: 'integer', minimum: 1 }
          : { type: 'string', description: `경로 값 ${p}` });
    }
    if (query) properties['query'] = { ...toJsonSchema(query), description: 'URL 쿼리 값' };
    if (body) properties['body'] = { ...toJsonSchema(body), description: '요청 본문(JSON)' };

    const get = <T>(k: string) =>
      (Reflect.getMetadata(k, handler) ?? Reflect.getMetadata(k, metatype)) as T | undefined;
    const guards = [
      ...((Reflect.getMetadata(GUARDS_METADATA, metatype) as unknown[] | undefined) ?? []),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
    ];
    const isPublic = get<boolean>(IS_PUBLIC) === true;
    const role = get<MemberRole>(PROJECT_ROLE) ?? null;
    const readOnly = method === 'GET' || get<boolean>(PROJECT_READ_ONLY_POST) === true;
    const access = isPublic
      ? '로그인 불필요'
      : guards.includes(SysAdminGuard)
        ? '시스템 관리자'
        : role
          ? `프로젝트 ${role} 이상`
          : '로그인 사용자';
    return {
      key,
      name: spec.name,
      description: `${spec.description}\n[${method} ${path} · ${access}]`,
      method,
      path,
      pathParams,
      sysAdmin: guards.includes(SysAdminGuard),
      role,
      readOnly,
      inputSchema: {
        type: 'object',
        properties,
        required: [...pathParams, ...(body && method !== 'GET' ? ['body'] : [])],
        additionalProperties: false,
      },
    };
  }
}
