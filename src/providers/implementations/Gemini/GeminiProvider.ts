import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';
import { requestUrl, RequestUrlParam, Notice } from 'obsidian';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

// Gemini uses a different format for messages
interface GeminiMessage {
    role: 'user' | 'model';
    parts: {
        text?: string;
    }[];
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

export class GeminiProvider extends BaseProvider {
    name = 'Gemini';
    private url: string;
    protected abortController?: AbortController;
    private defaultModels = [
        'gemini-1.5-pro',
        'gemini-1.5-flash',
        'gemini-1.0-pro',
        'gemini-1.0-pro-vision'
    ];

    constructor(private apiKey: string, endpoint?: string) {
        super();
        this.url = endpoint?.trim().replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com/v1beta';
    }

    async getAvailableModels(): Promise<string[]> {
        try {
            // First check if we have configured visibleModels in the provider settings
            if (this.config && this.config.visibleModels && this.config.visibleModels.length > 0) {
                // Return the models from provider settings
                return this.config.visibleModels;
            }
            
            // Unfortunately, Google AI doesn't have a models endpoint available in the free API
            // We'll use our default models list as a fallback
            return [...this.defaultModels];
        } catch (error) {
            console.error('Error fetching Gemini models:', error);
            // Return default models if there's an error
            return this.defaultModels;
        }
    }

    async sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string> {
        try {
            if (!message?.trim()) {
                return '';
            }
            const messages = this.buildMessages(message, options?.messageHistory);
            const model = options?.model || this.config?.defaultModel || 'gemini-1.5-flash';
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
        messages: GeminiMessage[],
        model: string,
        temperature: number,
        maxTokens: number,
        systemPrompt: string,
        stream?: boolean,
        onToken?: (token: string) => void
    ): Promise<string> {
        // Force stream to false since Gemini doesn't support reliable streaming in this implementation
        stream = false;
        
        this.abortController = new AbortController();

        // Build the request body
        const requestBody: any = {
            contents: messages,
            generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: temperature
            }
        };

        // Add system prompt if provided
        if (systemPrompt?.trim()) {
            requestBody.systemInstruction = {
                parts: [{ text: systemPrompt.trim() }]
            };
        }

        // Construct the API URL with the model in the path
        const apiUrl = `${this.url}/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}?key=${this.apiKey}`;

        try {
            if (stream && onToken) {
                // Use fetch for streaming
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody),
                    signal: this.abortController.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
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
                            if (!line.trim()) continue;

                            try {
                                const json = JSON.parse(line);
                                if (json.candidates?.[0]?.content?.parts?.[0]?.text) {
                                    const token = json.candidates[0].content.parts[0].text;
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
                // Use requestUrl for non-streaming requests
                const response = await requestUrl({
                    url: apiUrl,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                });

                if (response.status !== 200) {
                    throw new Error(`Gemini API error: ${response.status}`);
                }

                const result = response.json;
                return result.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

    private buildMessages(message: string, messageHistory?: MessageHistoryItem[]): GeminiMessage[] {
        // Clean message content by stripping HTML tags
        const cleanMessage = (text: string) => {
            const textNode = document.createTextNode(text);
            return textNode.textContent || '';
        };

        const messages: GeminiMessage[] = [];

        // Add message history if provided
        if (messageHistory && messageHistory.length > 0) {
            for (const historyItem of messageHistory) {
                // Map roles from the generic format to Gemini's format
                let role: 'user' | 'model';
                if (historyItem.role === 'user') {
                    role = 'user';
                } else if (historyItem.role === 'assistant') {
                    role = 'model';
                } else {
                    // Skip system messages or unknown roles
                    continue;
                }

                messages.push({
                    role: role,
                    parts: [{ text: cleanMessage(historyItem.content) }]
                });
            }
        }

        // Add the current message
        messages.push({
            role: 'user',
            parts: [{ text: cleanMessage(message) }]
        });

        return messages;
    }

    cancelRequest(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
    }
} 