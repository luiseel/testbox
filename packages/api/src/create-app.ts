import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { optionsFromEnv, type AppOptions } from './options';

export async function createApp(options: AppOptions = optionsFromEnv()): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(options), { logger: false });
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  return app;
}

export { optionsFromEnv };
export type { AppOptions };
