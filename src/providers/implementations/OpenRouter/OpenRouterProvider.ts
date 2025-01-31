import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ModelData {
    id: string;
    name?: string;
    pricing?: {
        prompt: string;
        completion: string;
    };
    context_length?: number;
    architecture?: string;
}

interface OpenRouterResponse {
    data: ModelData[];
}

interface OpenRouterStreamResponse {
    choices: Array<{
        delta: {
            content?: string;
        };
    }>;
}

interface OpenRouterConfig extends ProviderSettings {
    debugLoggingEnabled?: boolean;
}

export class OpenRouterProvider extends BaseProvider {
    name = 'OpenRouter';
    private url = 'https://openrouter.ai/api/v1';
    protected settings: { debugLoggingEnabled?: boolean } = {};

    constructor(private apiKey: string) {
        super();
    }

    setConfig(config: OpenRouterConfig) {
        super.setConfig(config);
        this.settings = {
            debugLoggingEnabled: config?.debugLoggingEnabled
        };
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.url}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.href,
                    'X-Title': 'FLARE.ai Obsidian Plugin',
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json() as OpenRouterResponse;
            if (!data.data || !Array.isArray(data.data)) {
                throw new Error('Invalid response format from OpenRouter API');
            }

            this.models = data.data
                .filter(m => m.id && typeof m.id === 'string')
                .map(m => m.id)
                .sort((a, b) => {
                    const cleanA = a.split('/').pop() || a;
                    const cleanB = b.split('/').pop() || b;
                    return cleanA.localeCompare(cleanB);
                });

            return this.models;
        } catch (error) {
            throw error;
        }
    }

    async sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string> {
        try {
            const cleanMessage = (text: string) => {
                const textNode = document.createTextNode(text);
                return textNode.textContent || '';
            };

            const messages: ChatMessage[] = [];

            if (options?.messageHistory && options.messageHistory.length > 0) {
                const filteredHistory = options.messageHistory
                    .filter(msg => 
                        msg.content?.trim() && 
                        msg.role && 
                        !(msg.role === 'user' && msg.content.trim() === message.trim())
                    )
                    .map(msg => ({
                        role: msg.role as 'system' | 'user' | 'assistant',
                        content: cleanMessage(msg.content.trim())
                    }));

                messages.push(...filteredHistory);
            }

            if (message?.trim()) {
                messages.push({
                    role: 'user',
                    content: cleanMessage(message.trim())
                });
            }

            this.abortController = new AbortController();

            const requestBody = {
                model: options?.model || 'openai/gpt-3.5-turbo',
                messages: messages,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.maxTokens,
                stream: options?.stream ?? false
            };

            const response = await fetch(`${this.url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.href,
                    'X-Title': 'FLARE.ai Obsidian Plugin',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                try {
                    const error = JSON.parse(errorText);
                    throw new Error(`OpenRouter API error: ${error.error?.message || errorText}`);
                } catch (e) {
                    throw new Error(`OpenRouter API error: ${errorText}`);
                }
            }

            const isStreamingResponse = response.headers.get('content-type')?.includes('text/event-stream');

            if ((options?.stream && options.onToken) || isStreamingResponse) {
                if (!response.body) {
                    throw new Error('No response body received');
                }

                const reader = response.body.getReader();
                let completeResponse = '';
                const decoder = new TextDecoder();

                try {
                    let buffer = '';
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        buffer += chunk;

                        while (buffer.includes('\n')) {
                            const newlineIndex = buffer.indexOf('\n');
                            const line = buffer.slice(0, newlineIndex).trim();
                            buffer = buffer.slice(newlineIndex + 1);

                            if (!line || line === ': OPENROUTER PROCESSING' || line.startsWith(':')) {
                                continue;
                            }

                            if (line.startsWith('data: ')) {
                                const jsonStr = line.slice(6);
                                if (jsonStr === '[DONE]') continue;

                                try {
                                    const parsed = JSON.parse(jsonStr) as OpenRouterStreamResponse;
                                    const token = parsed.choices?.[0]?.delta?.content;
                                    if (token) {
                                        completeResponse += token;
                                        if (options?.onToken) {
                                            options.onToken(token);
                                        }
                                    }
                                } catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                    }

                    if (buffer.trim()) {
                        const line = buffer.trim();
                        if (line.startsWith('data: ')) {
                            const jsonStr = line.slice(6);
                            if (jsonStr !== '[DONE]') {
                                try {
                                    const parsed = JSON.parse(jsonStr) as OpenRouterStreamResponse;
                                    const token = parsed.choices?.[0]?.delta?.content;
                                    if (token) {
                                        completeResponse += token;
                                        if (options?.onToken) {
                                            options.onToken(token);
                                        }
                                    }
                                } catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                    }

                    return completeResponse;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        return 'Request aborted';
                    }
                    throw error;
                } finally {
                    reader.releaseLock();
                }
            }

            const responseText = await response.text();
            const jsonMatch = responseText.match(/data: ({.*})/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[1]);
                return data.choices[0].message.content;
            }
            const data = JSON.parse(responseText);
            return data.choices[0].message.content;
        } catch (error) {
            throw error;
        } finally {
            this.abortController = undefined;
        }
    }

    private async makeRequest(url: string, options: RequestInit) {
        const response = await fetch(url, options);
        return response;
    }
} 