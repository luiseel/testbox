import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';

export interface UserConfig {
  apiUrl: string;
  token: string;
  sshHost?: string;
  remoteRoot?: string;
  identityFile?: string;
  snapshotBin?: string;
}

export interface WorkerSession {
  sessionName: string;
  sshHost: string;
}

export interface WorkspaceState {
  id: string;
  project: string;
  sessionName: string;
  stagingRel: string;
  sshHost: string;
  remoteRoot: string;
  direct: boolean;
  configDir: string;
  workerId?: string;
  /** Per-worker Mutagen sessions. The snapshot is taken on the worker that will run the job. */
  sessions?: Record<string, WorkerSession>;
}

/** Every Mutagen session name a workspace state refers to, without duplicates or empty names. */
export function workspaceSessionNames(state: WorkspaceState): string[] {
  const names = new Set<string>([state.sessionName]);
  for (const session of Object.values(state.sessions ?? {})) names.add(session.sessionName);
  return [...names].filter((name) => name.length > 0);
}

export function userConfigPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'testbox', 'config.json');
}

export async function readUserConfig(homeDir: string): Promise<UserConfig | null> {
  try {
    const text = await readFile(userConfigPath(homeDir), 'utf8');
    return JSON.parse(text) as UserConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeUserConfig(homeDir: string, config: UserConfig): Promise<void> {
  const file = userConfigPath(homeDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

export function workspaceStatePath(dir: string): string {
  return path.join(dir, '.testbox', 'workspace.json');
}

export async function readWorkspaceState(dir: string): Promise<WorkspaceState | null> {
  try {
    return JSON.parse(await readFile(workspaceStatePath(dir), 'utf8')) as WorkspaceState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeWorkspaceState(dir: string, state: WorkspaceState): Promise<void> {
  const file = workspaceStatePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
}

export async function removeWorkspaceState(dir: string): Promise<void> {
  await rm(workspaceStatePath(dir), { force: true });
}

/** What `testbox admin` remembers about the fleet. Secrets stay on the control-plane host. */
export interface AdminConfig {
  controlPlane?: {
    sshHost: string;
    address: string;
    apiPort: number;
    redisPort: number;
    repoDir: string;
  };
}

export function adminConfigPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'testbox', 'admin.json');
}

export async function readAdminConfig(homeDir: string): Promise<AdminConfig> {
  try {
    return JSON.parse(await readFile(adminConfigPath(homeDir), 'utf8')) as AdminConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeAdminConfig(homeDir: string, config: AdminConfig): Promise<void> {
  const file = adminConfigPath(homeDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}
