import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Principal, PrincipalRole } from '@testbox/shared';
import { AuthService } from './auth.service';

export const IS_PUBLIC = 'testbox:public';
export const ROLES = 'testbox:roles';

export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: PrincipalRole[]) => SetMetadata(ROLES, roles);

export interface AuthedRequest extends Request {
  principal: Principal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw new UnauthorizedException('missing bearer token');
    const principal = await this.auth.authenticate(token);
    if (!principal) throw new UnauthorizedException('invalid token');
    req.principal = principal;
    const roles = this.reflector.getAllAndOverride<PrincipalRole[]>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) {
      if (principal.role === 'worker') throw new ForbiddenException('worker token cannot call this route');
      return true;
    }
    if (!roles.includes(principal.role)) throw new ForbiddenException('forbidden');
    return true;
  }
}
