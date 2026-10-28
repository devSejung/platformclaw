export class EmployeeExecutionHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 409 | 422 | 429,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeExecutionHttpError";
  }
}
