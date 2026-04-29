declare module "all-pusher-api" {
  export class PushApi {
    constructor(configs: Array<Record<string, unknown>>);
    send(opts: {
      message: string;
      type?: "markdown" | "html" | "text";
      extraOptions?: Record<string, unknown>;
    }): Promise<unknown>;
  }
}
