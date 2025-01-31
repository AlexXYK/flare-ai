import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';

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

    constructor(private apiKey: string, endpoint?: string) {
        super();
        this.url = endpoint?.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json() as OpenAIModelsResponse;
            return data.data.map(model => model.id);
        } catch (error) {
            throw error;
        }
    }

    async sendMessage(message: string, options?: MessageOptions): Promise<string> {
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
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
                        if (line.trim() === 'data: [DONE]') continue;

                        if (line.startsWith('data: ')) {
                            try {
                                const json = JSON.parse(line.slice(6));
                                const token = json.choices?.[0]?.delta?.content || '';
                                if (token) {
                                    finalResponse += token;
                                    onToken(token);
                                }
                            } catch (e) {
                                // Skip invalid JSON
                            }
                        }
                    }
                }

                return finalResponse;
            } else {
                const result = await response.json();
                return result.choices?.[0]?.message?.content || '';
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                return 'Request aborted';
            }
            throw error;
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