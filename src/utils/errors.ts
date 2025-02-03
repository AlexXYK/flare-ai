export function isError(error: unknown): error is Error {
    return error instanceof Error;
}

export function getErrorMessage(error: unknown): string {
    if (isError(error)) {
        return error.message;
    }
    return String(error);
}

export function handleError(error: unknown): Error {
    if (isError(error)) {
        return error;
    }
    return new Error(String(error));
} 