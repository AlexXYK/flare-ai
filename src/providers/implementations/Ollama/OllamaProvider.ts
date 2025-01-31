import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';
import { AIProvider } from '../../../types/AIProvider';

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
    private context: number[] | null = null;
    private currentModel: string = '';
    private url: string = '';

    constructor(url: string) {
        super();
        this.url = url.trim() || 'http://localhost:11434';
    }

    setConfig(config: ProviderSettings) {
        super.setConfig(config);
        this.url = config.baseUrl?.trim() || 'http://localhost:11434';
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.url}/api/tags`);
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(`Ollama API error: ${error.error || 'Unknown error'}`);
            }

            const data = await response.json() as OllamaResponse;
            this.models = (data.models || [])
                .map(model => model.name);

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

    async sendMessage(message: string, options?: MessageOptions): Promise<string> {
        try {
            if (!message?.trim()) {
                return '';
            }
            const messages = this.buildMessages(message, options?.messageHistory);
            const model = options?.model || this.config.defaultModel;
            if (!model) {
                throw new Error('No model specified for Ollama provider');
            }
            const temperature = options?.temperature ?? 0.7;
            const maxTokens = options?.maxTokens;

            const response = await this.makeRequest(messages, model, temperature, maxTokens, options?.stream, options?.onToken);
            return response;
        } catch (error) {
            throw error;
        }
    }

    private async makeRequest(
        messages: Array<{role: string; content: string}>,
        model: string,
        temperature: number,
        maxTokens?: number,
        stream?: boolean,
        onToken?: (token: string) => void
    ): Promise<string> {
        const controller = new AbortController();
        const signal = controller.signal;

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
                signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            if (stream && response.body && onToken) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let finalResponse = '';

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.trim() === '') continue;

                        try {
                            const json = JSON.parse(line) as OllamaChatResponse;
                            if (json.done) {
                                this.context = json.context || null;
                                continue;
                            }
                            
                            const token = json.message?.content || '';
                            if (token) {
                                finalResponse += token;
                                onToken(token);
                            }
                        } catch (e) {
                            // Skip invalid JSON
                        }
                    }
                }

                return finalResponse;
            } else {
                const result = await response.json() as OllamaChatResponse;
                this.context = result.context || null;
                return result.message?.content || '';
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                return 'Request aborted';
            }
            throw error;
        }
    }

    private buildMessages(message: string, history?: Array<{role: string; content: string}>): Array<{role: string; content: string}> {
        const messages: Array<{role: string; content: string}> = [];
        
        // Add message history if available
        if (history?.length) {
            messages.push(...history);
        }

        // Add current message if not empty
        const trimmedMessage = message.trim();
        if (trimmedMessage) {
            messages.push({
                role: 'user',
                content: trimmedMessage
            });
        }

        return messages;
    }
} 