import { spawn } from "node:child_process";
import { config } from "../config.js";

/**
 * Run a CLI command, capture stdout. Injects HTTPS_PROXY/XAPI_API_KEY so
 * gmgn-cli/xapi-to/etc all hit our SSH tunnel + correct creds.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function exec(cmd: string, args: string[], opts?: {
  timeoutMs?: number;
  input?: string;
}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: {
        ...process.env,
        HTTPS_PROXY: config.proxy.https || process.env.HTTPS_PROXY || "",
        HTTP_PROXY: config.proxy.http || process.env.HTTP_PROXY || "",
        XAPI_API_KEY: config.xapi.apiKey || process.env.XAPI_API_KEY || "",
      },
    });

    let stdout = "";
    let stderr = "";
    const timeout = opts?.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`exec timeout after ${timeout}ms: ${cmd} ${args.join(" ")}`));
    }, timeout);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    if (opts?.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Helper: run a command and parse stdout as JSON, throw if exit non-zero. */
export async function execJson<T = unknown>(cmd: string, args: string[], opts?: {
  timeoutMs?: number;
}): Promise<T> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} exited ${r.code}: ${r.stderr.slice(0, 500) || r.stdout.slice(0, 500)}`);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch (e) {
    throw new Error(`${cmd} stdout not JSON: ${r.stdout.slice(0, 200)}...`);
  }
}
