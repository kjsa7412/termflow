import { Module } from '@nestjs/common';
import { BizAreaService } from './biz-area.service.js';
import { ProjectCopyService } from './copy/project-copy.service.js';
import { MemberService } from './member.service.js';
import { ProjectService } from './project.service.js';
import {
  AdminProjectsController,
  AdminTemplatesController,
  BizAreasController,
  MembersController,
  ProjectsController,
} from './projects.controller.js';
import { TemplateService } from './template.service.js';

/**
 * 프로젝트·업무구분·멤버·템플릿·복사 엔진(단계 5, 설계서 §4). 컨트롤러 순서: 전역 `/projects` 정적 경로가
 * `/projects/:projectKey`보다 먼저 등록되도록 ProjectsController를 맨 앞에 둔다.
 */
@Module({
  controllers: [
    ProjectsController,
    MembersController,
    BizAreasController,
    AdminProjectsController,
    AdminTemplatesController,
  ],
  providers: [ProjectService, ProjectCopyService, MemberService, BizAreaService, TemplateService],
  // TermCacheRegistry는 전역 AutocompleteModule이 제공한다(단계 9)
  exports: [ProjectCopyService],
})
export class ProjectModule {}
