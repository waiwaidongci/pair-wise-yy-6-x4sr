export function fail(status, code, message) {
  const error = new Error(message || code);
  error.status = status;
  error.code = code;
  return error;
}
