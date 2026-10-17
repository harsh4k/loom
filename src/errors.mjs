// A failure that can pass on its own (Ollama still starting, network down, a 429 or 5xx),
// so the scheduler may try the run again later. Every other failure is final for that day.
export class RetryableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RetryableError';
    this.retryable = true;
  }
}

export const isRetryable = (error) => error?.retryable === true;
