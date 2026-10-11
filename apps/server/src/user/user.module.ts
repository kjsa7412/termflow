import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller.js';
import { MeController } from './me.controller.js';
import { MeTokensController } from './me-tokens.controller.js';
import { UserService } from './user.service.js';

/** 내 계정·사용자 관리(T4.5·T4.6). */
@Module({
  controllers: [MeController, MeTokensController, AdminUsersController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
