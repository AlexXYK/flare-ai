import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';
import { requestUrl, RequestUrlParam } from 'obsidian';

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
    protected abortController: AbortController | undefined;

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
        this.abortController = new AbortController();

        try {
            // Create timeout promise
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    this.abortController?.abort();
                    reject(new Error('Request timed out while fetching models. Please try again.'));
                }, 10000);
            });

            // Use requestUrl instead of fetch
            const response = await requestUrl({
                url: `${this.url}/models`,
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.href,
                    'X-Title': 'FLARE.ai Obsidian Plugin',
                    'Content-Type': 'application/json',
                }
            });

            if (response.status !== 200) {
                if (response.status === 401) {
                    throw new Error('Invalid API key or unauthorized access');
                } else if (response.status === 429) {
                    throw new Error('Rate limit exceeded. Please try again later');
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = response.json as OpenRouterResponse;
            if (!data?.data || !Array.isArray(data.data)) {
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

            if (this.models.length === 0) {
                throw new Error('No models available from OpenRouter');
            }

            return this.models;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to fetch OpenRouter models: ${error.message}`);
            }
            throw error;
        } finally {
            this.abortController = undefined;
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

            const requestBody = {
                model: options?.model || 'openai/gpt-3.5-turbo',
                messages: messages,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.maxTokens,
                stream: options?.stream ?? false
            };

            this.abortController = new AbortController();

            if (options?.stream && options.onToken) {
                // Use fetch for streaming since requestUrl doesn't support it
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
                                        options.onToken(token);
                                    }
                                } catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }

                return completeResponse;
            } else {
                // Use requestUrl for non-streaming requests
                const response = await requestUrl({
                    url: `${this.url}/chat/completions`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'HTTP-Referer': window.location.href,
                        'X-Title': 'FLARE.ai Obsidian Plugin',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody)
                });

                if (response.status !== 200) {
                    const errorText = response.text;
                    try {
                        const error = JSON.parse(errorText);
                        throw new Error(`OpenRouter API error: ${error.error?.message || errorText}`);
                    } catch (e) {
                        throw new Error(`OpenRouter API error: ${errorText}`);
                    }
                }

                const data = response.json;
                return data.choices[0].message.content;
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                return 'Request aborted';
            }
            throw error;
        } finally {
            this.abortController = undefined;
        }
    }
} 