import { HIBOSS_TOKEN_ENV } from "../shared/env.js";

export { HIBOSS_TOKEN_ENV };

export function resolveAgentToken(token?: string): string {
  if (token && token.trim()) return token.trim();

  const fromEnv = process.env[HIBOSS_TOKEN_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  throw new Error(
    `Agent token is required. Provide --token <token> or set ${HIBOSS_TOKEN_ENV}.`
  );
}
