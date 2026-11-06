import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A headless Blender process (no window) driven over stdin/stdout by server/blender_worker.py.
 * Used by "New 3D object" generation: Claude's Python runs here, one session per request.
 */

const MARK = '@@VIS@@';
const WORKER = path.join(process.cwd(), 'server', 'blender_worker.py');

/** Blender executable: BLENDER_PATH, then the usual macOS locations, then `blender` on PATH. */
export function findBlender(envPath?: string): string | null {
  const candidates = [
    envPath,
    process.env.BLENDER_PATH,
    '/Applications/Blender.app/Contents/MacOS/Blender',
    path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender'),
    '/opt/homebrew/bin/blender',
    '/usr/local/bin/blender',
    '/usr/bin/blender',
    '/snap/bin/blender',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

export interface BlenderReply { ok: boolean; error?: string; output?: string; [k: string]: unknown }

export class BlenderSession {
  private proc: ChildProcess;
  private buffer = '';
  private waiting: ((r: BlenderReply) => void) | null = null;
  private queue: BlenderReply[] = [];
  private log: string[] = [];
  private closed = false;
  private exitError: Error | null = null;

  private constructor(bin: string) {
    // Run with a minimal environment: Claude-written code never sees API keys or other secrets.
    const env = { PATH: process.env.PATH ?? '', HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' };
    this.proc = spawn(bin, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', WORKER], {
      env,
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (chunk: string) => this.remember(chunk));
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      this.exitError = new Error(`Blender exited (${signal ?? code}).\n${this.recentLog()}`);
      this.deliver({ ok: false, error: this.exitError.message });
    });
    this.proc.on('error', (e) => {
      this.closed = true;
      this.exitError = e;
      this.deliver({ ok: false, error: e.message });
    });
  }

  static async start(bin: string, timeoutMs = 60000): Promise<BlenderSession> {
    const s = new BlenderSession(bin);
    const ready = await s.next(timeoutMs);
    if (!ready.ok) { s.close(); throw new Error(`Blender failed to start: ${ready.error}`); }
    return s;
  }

  /** Run one command; kills the session if it takes longer than timeoutMs. */
  async call(cmd: Record<string, unknown>, timeoutMs = 120000): Promise<BlenderReply> {
    if (this.closed) throw this.exitError ?? new Error('Blender session is closed');
    this.proc.stdin!.write(JSON.stringify(cmd) + '\n');
    return this.next(timeoutMs);
  }

  recentLog(lines = 15) {
    return this.log.slice(-lines).join('\n');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.stdin!.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* ignore */ }
    const p = this.proc;
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 3000);
  }

  private next(timeoutMs: number): Promise<BlenderReply> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.proc.kill('SIGKILL');
        resolve({ ok: false, error: `Blender did not answer within ${Math.round(timeoutMs / 1000)}s, so the session was stopped (all work in it is lost). Avoid very heavy operations.` });
      }, timeoutMs);
      this.waiting = (r) => { clearTimeout(timer); resolve(r); };
    });
  }

  private deliver(r: BlenderReply) {
    const w = this.waiting;
    if (w) { this.waiting = null; w(r); } else this.queue.push(r);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const at = line.indexOf(MARK);
      if (at >= 0) {
        try { this.deliver(JSON.parse(line.slice(at + MARK.length))); }
        catch (e) { this.deliver({ ok: false, error: `Bad reply from Blender: ${(e as Error).message}` }); }
      } else {
        this.remember(line);
      }
    }
  }

  private remember(text: string) {
    for (const l of text.split('\n')) if (l.trim()) this.log.push(l);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }
}
