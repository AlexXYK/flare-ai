import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';
import { requestUrl, RequestUrlParam, Notice } from 'obsidian';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

// Anthropic uses a different format for messages
interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface AnthropicModel {
    name: string;
    description: string;
    context_window: number;
    max_tokens: number;
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

export class AnthropicProvider extends BaseProvider {
    name = 'Anthropic';
    private url: string;
    protected abortController?: AbortController;
    private defaultModels = [
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
        'claude-2.1',
        'claude-2.0',
        'claude-instant-1.2'
    ];

    constructor(private apiKey: string, endpoint?: string) {
        super();
        this.url = endpoint?.trim().replace(/\/+$/, '') || 'https://api.anthropic.com/v1';
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            // Use the official Anthropic models endpoint
            const response = await requestUrl({
                url: `${this.url}/models`,
                method: 'GET',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                }
            });

            if (response.status !== 200) {
                const errorData = response.json;
                const errorMessage = errorData?.error?.message || `Status code: ${response.status}`;
                console.error('Error response from Anthropic models API:', errorData);
                throw new Error(`Failed to fetch Anthropic models: ${errorMessage}`);
            }

            const result = response.json;
            if (!result.data || !Array.isArray(result.data)) {
                console.warn('Unexpected response format from Anthropic models API:', result);
                // Fallback to default models if API response is unexpected
                this.models = [...this.defaultModels];
                return this.models;
            }
            
            // Extract model names from the response
            const modelNames = result.data.map((model: any) => model.id);
            
            // Store and return the models
            this.models = modelNames.length > 0 ? modelNames : [...this.defaultModels];
            return this.models;
        } catch (error) {
            console.error('Error fetching Anthropic models:', error);
            // Fallback to default models on error
            this.models = [...this.defaultModels];
            
            if (error instanceof Error) {
                throw new Error(`Failed to fetch Anthropic models: ${error.message}`);
            }
            throw error;
        }
    }

    async sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string> {
        try {
            if (!message?.trim()) {
                return '';
            }
            const messages = this.buildMessages(message, options?.messageHistory);
            const model = options?.model || this.config?.defaultModel || 'claude-3-haiku-20240307';
            const temperature = options?.temperature ?? 0.7;
            const maxTokens = options?.maxTokens ?? 4000;
            const systemPrompt = options?.systemPrompt || '';

            const response = await this.makeRequest(
                messages, 
                model, 
                temperature, 
                maxTokens, 
                systemPrompt,
                options?.stream, 
                options?.onToken
            );
            return response;
        } catch (error) {
            throw error;
        }
    }

    private async makeRequest(
        messages: AnthropicMessage[],
        model: string,
        temperature: number,
        maxTokens: number,
        systemPrompt: string,
        stream?: boolean,
        onToken?: (token: string) => void
    ): Promise<string> {
        this.abortController = new AbortController();

        // Build the request body
        const requestBody: any = {
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream
        };

        if (systemPrompt?.trim()) {
            requestBody.system = systemPrompt.trim();
        }

        try {
            if (stream && onToken) {
                // Use fetch for streaming since requestUrl doesn't support it
                const response = await fetch(`${this.url}/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Anthropic-Version': '2023-06-01',
                        'x-api-key': this.apiKey
                    },
                    body: JSON.stringify(requestBody),
                    signal: this.abortController.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
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
                            if (!line.trim() || line === 'data: [DONE]') continue;

                            if (line.startsWith('data: ')) {
                                try {
                                    const json = JSON.parse(line.slice(6));
                                    if (json.type === 'content_block_delta') {
                                        const token = json.delta?.text || '';
                                        if (token) {
                                            completeResponse += token;
                                            onToken(token);
                                        }
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
                    url: `${this.url}/messages`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Anthropic-Version': '2023-06-01',
                        'x-api-key': this.apiKey
                    },
                    body: JSON.stringify({
                        ...requestBody,
                        stream: false
                    })
                });

                if (response.status !== 200) {
                    throw new Error(`Anthropic API error: ${response.status}`);
                }

                const result = response.json;
                return result.content?.[0]?.text || '';
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

    private buildMessages(message: string, messageHistory?: MessageHistoryItem[]): AnthropicMessage[] {
        // Clean message content by stripping HTML tags
        const cleanMessage = (text: string) => {
            const textNode = document.createTextNode(text);
            return textNode.textContent || '';
        };

        // Build messages array
        const messages: AnthropicMessage[] = [];

        // Add message history if available
        if (messageHistory?.length) {
            const validRoles = ['user', 'assistant'] as const;
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

            // Anthropic requires starting with a user message
            if (filteredHistory.length > 0 && filteredHistory[0].role !== 'user') {
                // If history starts with assistant, prepend a placeholder user message
                messages.push({
                    role: 'user',
                    content: 'Hello'
                });
            }

            messages.push(...filteredHistory);
        }

        // Add current message if not empty
        if (message?.trim()) {
            // If the last message was from the user and we're adding another user message,
            // we need to add a placeholder assistant message in between
            if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
                messages.push({
                    role: 'assistant',
                    content: 'I understand.'
                });
            }

            messages.push({
                role: 'user',
                content: cleanMessage(message.trim())
            });
        }

        return messages;
    }
} 