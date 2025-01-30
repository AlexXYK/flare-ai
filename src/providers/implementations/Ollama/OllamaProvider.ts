import { BaseProvider } from '../../base/BaseProvider';
import { AIProviderOptions, ProviderSettings } from '../../../types/AIProvider';
import { StreamingOptions } from '../../base/BaseProvider';

interface OllamaModel {
    name: string;
    modified_at: string;
    size: number;
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export class OllamaProvider extends BaseProvider {
    name = 'Ollama';
    protected models: string[] = [];
    private context: any = null;
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

            const data = await response.json();
            this.models = (data.models || [])
                .map((model: OllamaModel) => model.name);

            // Filter models based on visibility settings if configured
            if (this.config?.visibleModels?.length) {
                this.models = this.models.filter(model => 
                    this.config.visibleModels?.includes(model)
                );
            }

            return this.models;
        } catch (error) {
            console.error('Failed to fetch Ollama models:', error);
            throw error;
        }
    }

    public stopRequest(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    async sendMessage(message: string, options?: AIProviderOptions & StreamingOptions): Promise<string> {
        try {
            // Ensure we have a valid model
            if (!options?.model) {
                throw new Error('No model specified for Ollama provider');
            }

            // If no message history is provided, return early for empty messages
            if (!message?.trim() && (!options?.messageHistory || options.messageHistory.length === 0)) {
                return '';
            }

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
                        content: msg.content
                    }));

                messages.push(...filteredHistory);
            }

            // Add current message
            if (message?.trim()) {
                messages.push({
                    role: 'user',
                    content: message.trim()
                });
            }

            // Add debug logging
            if (this.config?.debugLoggingEnabled) {
                console.debug('Ollama messages:', messages.map(m => ({
                    role: m.role,
                    content: m.content.substring(0, 50) + '...'
                })));
            }

            const requestBody = {
                model: options.model,
                messages: messages,
                temperature: options?.temperature ?? 0.7,
                context: options?.isFlareSwitch ? undefined : this.context,
                stream: true  // Always stream for Ollama, it handles both formats well
            };

            // Create new abort controller for this request
            this.abortController = new AbortController();

            const response = await fetch(`${this.url}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(`Ollama API error: ${error.error || 'Unknown error'}`);
            }

            // Handle streaming response
            if (options?.stream && options.onToken) {
                const reader = response.body?.getReader();
                if (!reader) throw new Error('Failed to get response reader');

                let completeResponse = '';
                const decoder = new TextDecoder();
                let wasAborted = false;

                try {
                    while (true) {
                        // If we were aborted, stop reading new chunks
                        if (this.abortController?.signal.aborted) {
                            wasAborted = true;
                            break;
                        }

                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n').filter(line => line.trim());

                        for (const line of lines) {
                            try {
                                const data = JSON.parse(line);
                                if (data.message?.content) {
                                    const token = data.message.content;
                                    completeResponse += token;
                                    options.onToken(token);
                                }
                                if (data.context) {
                                    this.context = data.context;
                                }
                            } catch (e) {
                                console.warn('Failed to parse streaming response line:', e);
                            }
                        }
                    }
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log('Request aborted');
                        wasAborted = true;
                    } else {
                        throw error;
                    }
                } finally {
                    reader.releaseLock();
                    // Clear context if this was aborted or a flare switch
                    if (wasAborted || options?.isFlareSwitch) {
                        this.context = null;
                    }
                }

                return completeResponse;
            }

            // Handle non-streaming response
            let responseText = '';
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Failed to get response reader');
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n').filter(line => line.trim());
                    
                    for (const line of lines) {
                        try {
                            const data = JSON.parse(line);
                            if (data.message?.content) {
                                responseText += data.message.content;
                            }
                            if (data.context) {
                                this.context = data.context;
                            }
                        } catch (e) {
                            console.warn('Failed to parse response line:', e);
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }

            return responseText;
        } catch (error) {
            console.error('Failed to send message to Ollama:', error);
            throw error;
        } finally {
            // Clear abort controller after request is done
            this.abortController = undefined;

            // Only clear context on flare switch
            if (options?.isFlareSwitch) {
                this.context = null;
            }
        }
    }
} 