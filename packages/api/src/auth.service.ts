import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  createId,
  generateToken,
  JobStore,
  tokenHash,
  type Principal,
  type UserRecord,
} from '@testbox/shared';
import { APP_OPTIONS, JOB_STORE, type AppOptions } from './options';

@Injectable()
export class AuthService {
  constructor(
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(APP_OPTIONS) private readonly options: AppOptions,
  ) {}

  async ensureBootstrap(): Promise<void> {
    if (this.options.bootstrapToken) {
      const hash = tokenHash(this.options.bootstrapToken);
      const existing = await this.store.getToken(hash);
      if (!existing) {
        let admin = await this.store.findUserByName('admin');
        if (!admin) {
          admin = { id: 'usr_admin', name: 'admin', role: 'admin', createdAt: Date.now() };
          await this.store.createUser(admin);
        }
        await this.store.saveToken(hash, admin.id, admin.role);
      }
    }
    if (this.options.workerToken) {
      const hash = tokenHash(this.options.workerToken);
      const existing = await this.store.getToken(hash);
      if (!existing) await this.store.saveToken(hash, 'worker', 'worker');
    }
  }

  async authenticate(token: string): Promise<Principal | null> {
    if (!token) return null;
    const row = await this.store.getToken(tokenHash(token));
    if (!row) return null;
    if (row.role === 'worker') return { id: 'worker', role: 'worker', name: 'worker' };
    const user = await this.store.getUser(row.userId);
    if (!user) return null;
    return { id: user.id, role: user.role, name: user.name };
  }

  findUserByName(name: string): Promise<UserRecord | null> {
    return this.store.findUserByName(name);
  }

  async createUser(name: string, actorId: string): Promise<UserRecord> {
    const existing = await this.store.findUserByName(name);
    if (existing) throw new AppError('CONFLICT', 'user already exists', 409);
    const user: UserRecord = { id: createId('usr'), name, role: 'user', createdAt: Date.now() };
    await this.store.createUser(user);
    await this.store.audit({ at: Date.now(), actorId, action: 'user.create', subject: user.id });
    return user;
  }

  async issueToken(userId: string, actorId: string): Promise<string> {
    const user = await this.store.getUser(userId);
    if (!user) throw new AppError('NOT_FOUND', 'user not found', 404);
    const token = generateToken();
    await this.store.saveToken(tokenHash(token), user.id, user.role);
    await this.store.audit({ at: Date.now(), actorId, action: 'token.create', subject: user.id });
    return token;
  }
}
