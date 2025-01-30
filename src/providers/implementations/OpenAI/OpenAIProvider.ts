import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
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
            const response = await fetch(`${this.url}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(`OpenAI API error: ${error.error?.message || 'Unknown error'}`);
            }

            const data = await response.json();
            this.models = data.data
                .filter((m: any) => m.id.startsWith('gpt-'))
                .map((m: any) => m.id);
            return this.models;
        } catch (error) {
            console.error('Failed to fetch OpenAI models:', error);
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

            // Build messages array
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
                        content: cleanMessage(msg.content)
                    }));

                messages.push(...filteredHistory);
            }

            // Add current message
            if (message?.trim()) {
                messages.push({
                    role: 'user',
                    content: cleanMessage(message)
                });
            }

            // Add debug logging
            if (this.config?.debugLoggingEnabled) {
                console.debug('OpenAI messages:', messages.map(m => ({
                    role: m.role,
                    content: m.content.substring(0, 50) + '...'
                })));
            }

            // Create new abort controller for this request
            this.abortController = new AbortController();

            const response = await fetch(`${this.url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: options?.model || 'gpt-3.5-turbo',
                    messages: messages,
                    temperature: options?.temperature ?? 0.7,
                    max_tokens: options?.maxTokens,
                    stream: options?.stream ?? false
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                try {
                    const error = JSON.parse(errorText);
                    throw new Error(`OpenAI API error: ${error.error?.message || errorText}`);
                } catch (e) {
                    throw new Error(`OpenAI API error: ${errorText}`);
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

                            // Skip empty lines and SSE comments
                            if (!line || line.startsWith(':')) {
                                continue;
                            }

                            // Handle SSE data lines
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') continue;

                                try {
                                    const parsed = JSON.parse(data);
                                    const token = parsed.choices?.[0]?.delta?.content;
                                    if (token) {
                                        completeResponse += token;
                                        if (options?.onToken) {
                                            options.onToken(token);
                                        }
                                    }
                                } catch (e) {
                                    console.warn('Failed to parse SSE data:', { 
                                        line,
                                        data,
                                        error: e 
                                    });
                                }
                            }
                        }
                    }

                    // Process any remaining buffer content
                    if (buffer.trim()) {
                        const line = buffer.trim();
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if (data !== '[DONE]') {
                                try {
                                    const parsed = JSON.parse(data);
                                    const token = parsed.choices?.[0]?.delta?.content;
                                    if (token) {
                                        completeResponse += token;
                                        if (options?.onToken) {
                                            options.onToken(token);
                                        }
                                    }
                                } catch (e) {
                                    console.warn('Failed to parse final SSE data:', { 
                                        line,
                                        data,
                                        error: e 
                                    });
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
            // Skip any SSE prefixes
            const jsonMatch = responseText.match(/data: ({.*})/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[1]);
                return data.choices[0].message.content;
            }
            // If no SSE prefix, try parsing the whole response
            const data = JSON.parse(responseText);
            return data.choices[0].message.content;
        } catch (error) {
            console.error('Failed to send message to OpenAI:', error);
            throw error;
        } finally {
            // Clear abort controller after request is done
            this.abortController = undefined;
        }
    }
} 