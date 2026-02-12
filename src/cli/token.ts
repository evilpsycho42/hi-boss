import { HIBOSS_TOKEN_ENV } from "../shared/env.js";

export { HIBOSS_TOKEN_ENV };

export function resolveToken(token?: string): string {
  if (token && token.trim()) return token.trim();

  const fromEnv = process.env[HIBOSS_TOKEN_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  throw new Error(
    `Token is required. Provide --token <token> or set ${HIBOSS_TOKEN_ENV}.`
  );
}
