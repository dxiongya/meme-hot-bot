/**
 * Install a global undici ProxyAgent so every in-process fetch() call routes
 * through the SSH-tunneled HTTP proxy. Must be called once at bootstrap, before
 * pi-ai issues any LLM request.
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { config } from "../config.js";

let installed = false;

export function installGlobalProxy(): void {
  if (installed) return;
  const url = config.proxy.https || config.proxy.http;
  if (!url) {
    console.log("[proxy] no HTTPS_PROXY set — direct egress");
    return;
  }
  setGlobalDispatcher(new ProxyAgent(url));
  installed = true;
  console.log(`[proxy] global undici dispatcher → ${url}`);
}
