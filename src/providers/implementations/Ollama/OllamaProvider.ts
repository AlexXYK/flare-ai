import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';
import { AIProvider } from '../../../types/AIProvider';
import { requestUrl, RequestUrlParam } from 'obsidian';

interface OllamaModel {
    name: string;
    modified_at: string;
    size: number;
}

interface OllamaResponse {
    models: OllamaModel[];
}

interface OllamaChatResponse {
    message: {
        content: string;
        role: string;
    };
    done: boolean;
    context?: number[];
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface MessageOptions {
    messageHistory?: Array<{role: string; content: string}>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onToken?: (token: string) => void;
}

export class OllamaProvider extends BaseProvider implements AIProvider {
    name = 'Ollama';
    protected models: string[] = [];
    private context: number[] = [];
    private currentModel: string = '';
    private url: string = '';
    protected abortController: AbortController | undefined;

    constructor(private baseUrl: string) {
        super();
        this.url = baseUrl.trim() || 'http://localhost:11434';
    }

    setConfig(config: ProviderSettings) {
        super.setConfig(config);
        this.url = config.baseUrl?.trim() || 'http://localhost:11434';
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await requestUrl({
                url: `${this.config.baseUrl}/api/tags`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                throw: false
            });

            if (response.status !== 200) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = response.json;
            this.models = data.models?.map((model: any) => model.name) || [];

            return this.models;
        } catch (error) {
            throw error;
        }
    }

    public stopRequest(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    async sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string> {
        const model = options?.model || this.config?.defaultModel || 'llama2';
        const temperature = options?.temperature ?? 0.7;
        const maxTokens = options?.maxTokens;
        const stream = options?.stream ?? false;
        const onToken = options?.onToken;

        const messages = this.buildMessages(message, options?.messageHistory);
        this.abortController = new AbortController();

        try {
            const response = await fetch(`${this.config.baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages,
                    stream,
                    context: this.context,
                    options: {
                        temperature,
                        num_predict: maxTokens
                    }
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (stream && onToken) {
                let completeResponse = '';
                const reader = response.body?.getReader();
                const decoder = new TextDecoder();

                if (!reader) {
                    throw new Error('Failed to get response reader');
                }

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n');

                        for (const line of lines) {
                            if (!line.trim()) continue;

                            try {
                                const data = JSON.parse(line);
                                if (data.done) {
                                    // Store context for future requests if available
                                    if (data.context) {
                                        this.context = data.context;
                                    }
                                    continue;
                                }

                                const token = data.message?.content || '';
                                if (token) {
                                    completeResponse += token;
                                    onToken(token);
                                }
                            } catch (e) {
                                // Skip invalid JSON
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }

                return completeResponse;
            } else {
                const result = await response.json();
                // Store context for future requests if available
                if (result.context) {
                    this.context = result.context;
                }
                return result.message?.content || '';
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('Request aborted');
                return 'Request aborted';
            }
            throw error;
        } finally {
            this.abortController = undefined;
        }
    }

    private buildMessages(message: string, history?: Array<{role: string; content: string}>): Array<{role: string; content: string}> {
        const messages: Array<{role: string; content: string}> = [];
        
        // Add message history if available
        if (history?.length) {
            messages.push(...history);
        }

        // Only add current message if it's not already the last message in history
        const trimmedMessage = message.trim();
        if (trimmedMessage && (!history?.length || history[history.length - 1].content !== trimmedMessage)) {
            messages.push({
                role: 'user',
                content: trimmedMessage
            });
        }

        return messages;
    }
} 