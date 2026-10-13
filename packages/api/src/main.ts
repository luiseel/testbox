import 'reflect-metadata';
import { createApp, optionsFromEnv } from './create-app';

async function main(): Promise<void> {
  const app = await createApp(optionsFromEnv());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
