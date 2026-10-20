// Exit codes are the Go CLI's contract: 0 ok · 1 generic · 2 usage · 3 auth · 4 not-found · 5 api/network.
export const EXIT_GENERIC = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_API = 5;

export class DoorayError extends Error {
  constructor(
    readonly exit: number,
    message: string,
    readonly apiCode = 0,
  ) {
    super(message);
  }
}

export const generic = (msg: string): DoorayError => new DoorayError(EXIT_GENERIC, msg);
export const usageError = (msg: string): DoorayError => new DoorayError(EXIT_USAGE, msg);
export const authError = (msg: string): DoorayError => new DoorayError(EXIT_AUTH, msg);
export const notFound = (msg: string): DoorayError => new DoorayError(EXIT_NOT_FOUND, msg);
export const apiError = (apiCode: number, msg: string): DoorayError => new DoorayError(EXIT_API, msg, apiCode);

export function exitCode(err: unknown): number {
  return err instanceof DoorayError ? err.exit : EXIT_GENERIC;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
