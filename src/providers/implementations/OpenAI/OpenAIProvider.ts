import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';
import { requestUrl, RequestUrlParam } from 'obsidian';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

interface OpenAIModelsResponse {
    data: OpenAIModel[];
    object: string;
}

interface MessageHistoryItem {
    role: string;
    content: string;
    settings?: {
        provider?: string;
        model?: string;
        temperature?: number;
        flare?: string;
        timestamp?: number;
    };
}

interface MessageOptions {
    messageHistory?: MessageHistoryItem[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onToken?: (token: string) => void;
}

export class OpenAIProvider extends BaseProvider {
    name = 'OpenAI';
    private url: string;
    protected abortController?: AbortController;

    constructor(private apiKey: string, endpoint?: string) {
        super();
        this.url = endpoint?.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await requestUrl({
                url: `${this.url}/models`,
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status !== 200) {
                if (response.status === 401) {
                    throw new Error('Invalid API key or unauthorized access');
                } else if (response.status === 429) {
                    throw new Error('Rate limit exceeded. Please try again later');
                }
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = response.json as OpenAIModelsResponse;
            if (!data?.data || !Array.isArray(data.data)) {
                throw new Error('Invalid response format from OpenAI API');
            }

            return data.data
                .filter(model => model.id && typeof model.id === 'string')
                .map(model => model.id)
                .sort((a, b) => a.localeCompare(b));
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to fetch OpenAI models: ${error.message}`);
            }
            throw error;
        }
    }

    async sendMessage(message: string, options?: MessageOptions & StreamingOptions): Promise<string> {
        try {
            if (!message?.trim()) {
                return '';
            }
            const messages = this.buildMessages(message, options?.messageHistory);
            const model = options?.model || this.config?.defaultModel;
            if (!model) {
                throw new Error('No model specified for OpenAI provider');
            }
            const temperature = options?.temperature ?? 0.7;
            const maxTokens = options?.maxTokens;

            // Use either the provided signal or create our own abort controller
            const externalSignal = options?.signal;
            this.abortController = new AbortController();
            
            // If an external signal is provided, handle its abort event
            if (externalSignal) {
                // If the signal is already aborted, throw immediately
                if (externalSignal.aborted) {
                    throw new Error('Request aborted by user');
                }
                
                // Otherwise, set up a listener to abort our controller when the external signal aborts
                externalSignal.addEventListener('abort', () => {
                    if (this.abortController) {
                        this.abortController.abort();
                    }
                });
            }

            const response = await this.makeRequest(
                messages, 
                model, 
                temperature, 
                maxTokens, 
                options?.stream, 
                options?.onToken,
                this.abortController.signal
            );
            return response;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                const abortError = new Error('Request aborted by user');
                abortError.name = 'AbortError';
                throw abortError;
            }
            throw error;
        } finally {
            // Ensure controller is properly cleaned up
            this.abortController = undefined;
        }
    }

    private async makeRequest(
        messages: Array<{role: string; content: string}>,
        model: string,
        temperature: number,
        maxTokens?: number,
        stream?: boolean,
        onToken?: (token: string) => void,
        signal?: AbortSignal
    ): Promise<string> {
        try {
            if (stream && onToken) {
                // Use fetch for streaming since requestUrl doesn't support it
                const response = await fetch(`${this.url}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature,
                        max_tokens: maxTokens,
                        stream
                    }),
                    signal
                });

                if (!response.ok) {
                    throw new Error(`OpenAI API error: ${response.status}`);
                }

                let completeResponse = '';
                const reader = response.body?.getReader();
                const decoder = new TextDecoder();

                if (!reader) {
                    throw new Error('Failed to get response reader');
                }

                try {
                    while (true) {
                        // Check if aborted before each read
                        if (signal?.aborted) {
                            throw new Error('Request aborted by user');
                        }
                        
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n');

                        for (const line of lines) {
                            if (!line.trim() || line === 'data: [DONE]') continue;

                            if (line.startsWith('data: ')) {
                                try {
                                    const json = JSON.parse(line.slice(6));
                                    const token = json.choices?.[0]?.delta?.content || '';
                                    if (token) {
                                        completeResponse += token;
                                        onToken(token);
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
                // For non-streaming requests, use requestUrl with timeout wrapping
                // since requestUrl doesn't support AbortSignal directly
                const makeRequest = async () => {
                    const response = await requestUrl({
                        url: `${this.url}/chat/completions`,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.apiKey}`
                        },
                        body: JSON.stringify({
                            model,
                            messages,
                            temperature,
                            max_tokens: maxTokens,
                            stream: false
                        })
                    });

                    if (response.status !== 200) {
                        throw new Error(`OpenAI API error: ${response.status}`);
                    }

                    const result = response.json;
                    return result.choices?.[0]?.message?.content || '';
                };
                
                // Create a promise that rejects if the signal is aborted
                if (signal) {
                    if (signal.aborted) {
                        throw new Error('Request aborted by user');
                    }
                    
                    // Create a promise race between the request and a promise that rejects if aborted
                    return await Promise.race([
                        makeRequest(),
                        new Promise<string>((_, reject) => {
                            signal.addEventListener('abort', () => {
                                reject(new Error('Request aborted by user'));
                            });
                        })
                    ]);
                } else {
                    return await makeRequest();
                }
            }
        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Request aborted by user')) {
                const abortError = new Error('Request aborted by user');
                abortError.name = 'AbortError';
                throw abortError;
            }
            throw error;
        } finally {
            // Always clean up abortController when request completes
            // This ensures we don't have lingering references
            this.abortController = undefined;
        }
    }

    private buildMessages(message: string, messageHistory?: MessageHistoryItem[]): ChatMessage[] {
        // Clean message content by stripping HTML tags
        const cleanMessage = (text: string) => {
            // Create a text node to safely handle HTML content
            const textNode = document.createTextNode(text);
            return textNode.textContent || '';
        };

        // Build messages array
        const messages: ChatMessage[] = [];

        // Add message history if available
        if (messageHistory?.length) {
            const validRoles = ['system', 'user', 'assistant'] as const;
            type ValidRole = typeof validRoles[number];
            
            const filteredHistory = messageHistory
                .filter(msg => 
                    msg.content?.trim() && 
                    msg.role && 
                    validRoles.includes(msg.role as ValidRole) &&
                    // Don't include the last message if it matches our current message
                    !(msg.role === 'user' && msg.content.trim() === message.trim())
                )
                .map(msg => ({
                    role: msg.role as ValidRole,
                    content: cleanMessage(msg.content)
                }));

            messages.push(...filteredHistory);
        }

        // Add current message if not empty
        if (message?.trim()) {
            messages.push({
                role: 'user' as const,
                content: cleanMessage(message)
            });
        }

        return messages;
    }
} 