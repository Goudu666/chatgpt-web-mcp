export class ChatGPTWebError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ChatGPTWebError";
    this.details = details;
  }
}

export function userFacingError(error) {
  if (error instanceof ChatGPTWebError) {
    return {
      error: error.message,
      details: error.details,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
  };
}
