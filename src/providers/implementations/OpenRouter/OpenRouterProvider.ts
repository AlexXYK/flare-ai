import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export class OpenRouterProvider extends BaseProvider {
    name = 'OpenRouter';
    private url = 'https://openrouter.ai/api/v1';
    protected settings: { debugLoggingEnabled?: boolean } = {};

    constructor(private apiKey: string) {
        super();
    }

    setConfig(config: any) {
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

            const data = await response.json();
            if (!data.data || !Array.isArray(data.data)) {
                throw new Error('Invalid response format from OpenRouter API');
            }

            interface ModelData {
                id: string;
                name?: string;
            }

            this.models = data.data
                .filter((m: ModelData) => m.id && typeof m.id === 'string')
                .map((m: ModelData) => m.id)
                .sort((a: string, b: string) => {
                    // Remove common prefixes for sorting (e.g., "openai/", "anthropic/", etc.)
                    const cleanA = a.split('/').pop() || a;
                    const cleanB = b.split('/').pop() || b;
                    return cleanA.localeCompare(cleanB);
                });

            return this.models;
        } catch (error) {
            console.error('Failed to fetch OpenRouter models:', error);
            throw error;
        }
    }

    async sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string> {
        try {
            // Clean message content by stripping HTML tags
            const cleanMessage = (text: string) => {
                // Remove HTML tags and decode HTML entities
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = text;
                return tempDiv.textContent || tempDiv.innerText || '';
            };

            // Build messages array with cleaned content
            const messages: ChatMessage[] = [];

            // Add message history if available
            if (options?.messageHistory && options.messageHistory.length > 0) {
                // The history should already be properly windowed by main.ts
                const filteredHistory = options.messageHistory
                    .filter(msg => 
                        msg.content?.trim() && 
                        msg.role && 
                        // Don't include the last message if it matches our current message
                        !(msg.role === 'user' && msg.content.trim() === message.trim())
                    )
                    .map(msg => ({
                        role: msg.role as 'system' | 'user' | 'assistant',
                        content: cleanMessage(msg.content.trim())
                    }));

                messages.push(...filteredHistory);
            }

            // Add current message
            if (message?.trim()) {
                messages.push({
                    role: 'user',
                    content: cleanMessage(message.trim())
                });
            }

            // Add debug logging for messages being sent
            if (this.settings?.debugLoggingEnabled) {
                console.debug('OpenRouter messages:', messages.map(m => ({
                    role: m.role,
                    content: m.content.substring(0, 50) + '...'
                })));
            }

            // Create new abort controller for this request
            this.abortController = new AbortController();

            const requestBody = {
                model: options?.model || 'openai/gpt-3.5-turbo',
                messages: messages,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.maxTokens,
                stream: options?.stream ?? false
            };

            // Add debug logging
            if (this.settings?.debugLoggingEnabled) {
                console.debug('OpenRouter request:', {
                    url: `${this.url}/chat/completions`,
                    headers: {
                        'Authorization': 'Bearer [HIDDEN]',
                        'HTTP-Referer': window.location.href,
                        'X-Title': 'FLARE.ai Obsidian Plugin'
                    },
                    body: requestBody
                });
            }

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

            // Check if this is a streaming response
            const isStreamingResponse = response.headers.get('content-type')?.includes('text/event-stream');

            // Handle streaming response
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

                        // Decode chunk and add to buffer
                        const chunk = decoder.decode(value, { stream: true });
                        buffer += chunk;

                        // Process complete lines
                        while (buffer.includes('\n')) {
                            const newlineIndex = buffer.indexOf('\n');
                            const line = buffer.slice(0, newlineIndex).trim();
                            buffer = buffer.slice(newlineIndex + 1);

                            if (this.settings?.debugLoggingEnabled) {
                                console.debug('Processing line:', { line });
                            }

                            // Skip empty lines and OpenRouter heartbeats
                            if (!line || line === ': OPENROUTER PROCESSING' || line.startsWith(':')) {
                                if (this.settings?.debugLoggingEnabled) {
                                    console.debug('Skipping line:', { line });
                                }
                                continue;
                            }

                            // Handle SSE data lines
                            if (line.startsWith('data: ')) {
                                const jsonStr = line.slice(6);
                                if (jsonStr === '[DONE]') continue;

                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const token = parsed.choices?.[0]?.delta?.content;
                                    if (token) {
                                        completeResponse += token;
                                        if (options?.onToken) {
                                            options.onToken(token);
                                        }
                                    }
                                } catch (e) {
                                    if (this.settings?.debugLoggingEnabled) {
                                        console.debug('Failed to parse JSON:', { 
                                            line,
                                            jsonStr,
                                            error: e 
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // Process any remaining buffer content
                    if (buffer.trim()) {
                        if (this.settings?.debugLoggingEnabled) {
                            console.debug('Processing remaining buffer:', { buffer });
                        }

                        const line = buffer.trim();
                        if (line.startsWith('data: ')) {
                            const jsonStr = line.slice(6);
                            if (jsonStr !== '[DONE]') {
                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const token = parsed.choices?.[0]?.delta?.content;
                                    if (token) {
                                        completeResponse += token;
                                        if (options?.onToken) {
                                            options.onToken(token);
                                        }
                                    }
                                } catch (e) {
                                    if (this.settings?.debugLoggingEnabled) {
                                        console.debug('Failed to parse remaining JSON:', { 
                                            line,
                                            jsonStr,
                                            error: e 
                                        });
                                    }
                                }
                            }
                        }
                    }

                    return completeResponse;
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log('Request aborted');
                    }
                    throw error;
                } finally {
                    reader.releaseLock();
                }
            }

            // Handle non-streaming response
            const responseText = await response.text();
            // Skip any SSE prefixes or heartbeats
            const jsonMatch = responseText.match(/data: ({.*})/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[1]);
                return data.choices[0].message.content;
            }
            // If no SSE prefix, try parsing the whole response
            const data = JSON.parse(responseText);
            return data.choices[0].message.content;
        } catch (error) {
            console.error('Failed to send message to OpenRouter:', error);
            throw error;
        } finally {
            this.abortController = undefined;
        }
    }

    private async makeRequest(url: string, options: RequestInit) {
        if (this.settings.debugLoggingEnabled) {
            console.log('OpenRouter request:', {
                url,
                headers: options.headers,
                body: options.body
            });
        }
        // ... rest of the method
    }
} 