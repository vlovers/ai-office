export interface CodexDiagnostic {
  message: string;
  category: 'authentication' | 'connection' | 'provider';
}
// Never relay raw CLI stderr, backend response bodies, headers, or auth diagnostics to UI/SQLite.
export function codexDiagnostic(error: unknown): CodexDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /401|unauthorized|authentication|not logged|token.{0,30}expir|login.{0,30}expir|refresh.{0,30}fail/i.test(
      message,
    )
  )
    return {
      category: 'authentication',
      message:
        'Authentication required. Check the selected Codex sign-in and refresh the connection. No API fallback was used.',
    };
  if (/429|rate.limit|quota|usage.limit/i.test(message))
    return {
      category: 'connection',
      message:
        'Connection error. Codex allowance or rate limit reached. Retry later; no API fallback was used.',
    };
  if (
    /connect|network|dns|resolve|timed out|timeout|stream disconnected|403|forbidden/i.test(message)
  )
    return {
      category: 'connection',
      message:
        'Connection error. Codex could not complete the provider request. Refresh the connection and retry.',
    };
  const exitCode = /Codex Exec exited with code (\d+)/.exec(message)?.[1];
  return {
    category: 'provider',
    message: exitCode
      ? `Codex runtime exited unexpectedly (code ${exitCode}).`
      : 'Codex task failed. Provider diagnostics were withheld to protect authentication details.',
  };
}
