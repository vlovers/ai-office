export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
