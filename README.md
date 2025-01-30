# FLARE.ai for Obsidian

A powerful AI chat interface for Obsidian that supports multiple providers and customizable personas (Flares) with advanced context management.

**Version**: 1.0.0

## 📚 User Guide

### Features
- 🤖 Multiple AI Provider Support
  - Local AI through Ollama
  - OpenAI API integration
  - OpenRouter API support
  - Easy provider configuration
  - Dynamic model selection
  - Real-time model refresh
  - Streaming responses

- 🔥 Flare Management
  - Create custom AI personas
  - Configure provider settings
  - Set temperature and token limits
  - Custom system prompts
  - Easy flare switching with @mentions
  - Markdown-based storage

- ⚡ Modern UI/UX
  - Clean, consistent interface
  - Multiple view locations
  - Real-time settings updates
  - Message actions (copy, edit, delete)
  - Stop generation support
  - Auto-generated chat titles

### Quick Start
1. Open Settings > FLARE.ai
2. Add at least one provider:
   - For Ollama: Use default endpoint `http://localhost:11434`
   - For OpenAI: Add your API key
   - For OpenRouter: Add your API key
3. Create your first Flare in your vault's `FLAREai/flares` directory
4. Start chatting!

### Using Flares
Flares are markdown files that define AI personas. They live in your vault and can be edited directly.

Example Flare:
```markdown
---
name: Code Assistant
description: Programming and technical help
provider: ollama-default
model: codellama
temperature: 0.7
maxTokens: 2048
historyWindow: 3
handoffWindow: 1
stream: true
enabled: true
isReasoningModel: false
---

You are an expert programmer focused on clear explanations and practical examples.
- Provide code snippets when relevant
- Explain complex concepts simply
- Suggest best practices
```

### Chat Features
- Switch models on the fly
- Adjust creativity with temperature
- Change providers instantly
- Settings persist per chat
- Use @mentions for quick flare switching
- Control context window size
- Auto-generate chat titles with `/title`
- Automatic chat history management
- Reasoning model support with expandable thought process

### Security Note
API keys are stored in plain text in your vault's `.obsidian/plugins/flare-ai/data.json` file. Consider:
- Using separate API keys for different devices
- Setting appropriate usage limits
- Regular key rotation
- Usage monitoring
- Setting provider timeouts

## 🛠️ Developer Guide

### Architecture Overview

#### Core Components
- **FlareManager**: Handles Flare lifecycle (create, edit, delete)
- **ProviderManager**: Manages AI providers and model loading
- **ChatHistoryManager**: Handles message history and context windows
- **AIChatView**: Main chat interface with real-time updates

#### Project Structure
```
src/
├── main.ts                    # Plugin entry point
├── settings/                  # Settings management
├── providers/                 # Provider implementations
├── flares/                   # Flare management
├── views/                    # UI components
├── history/                  # History management
└── types/                    # TypeScript definitions
```

### Message Handling

#### Provider Differences

##### Ollama
- Uses native context management through Ollama's context field
- Always streams responses for better performance
- Preserves context between messages unless:
  - A flare switch occurs
  - The request is aborted
- Message format:
```json
{
    "model": "model_name",
    "messages": [...],
    "temperature": 0.7,
    "context": "previous_context",
    "stream": true
}
```

##### OpenAI/OpenRouter
- Handles context through message history
- Cleans message content by stripping HTML tags
- Filters out system messages from history
- Deduplicates user messages
- Message format:
```json
{
    "model": "model_name",
    "messages": [
        {"role": "system", "content": "system_prompt"},
        {"role": "user", "content": "cleaned_message"},
        {"role": "assistant", "content": "response"}
    ],
    "temperature": 0.7,
    "max_tokens": 2048,
    "stream": false
}
```

### Context Management

#### History Window
Controls message pairs in normal conversation:
- Set with `historyWindow` in flare config
- -1: Keep all messages
- 0: Keep no history
- N: Keep N user/assistant pairs

#### Handoff Window
Controls message pairs during flare switches:
- Set with `handoffWindow` in flare config
- -1: Transfer all messages
- 0: Transfer no messages
- N: Transfer N most recent pairs

### Adding New Providers
1. Implement the `AIProvider` interface
2. Create provider manager class
3. Add to `aiProviders.ts`
4. Register in `main.ts`
5. Add provider-specific settings
6. Implement timeout handling
7. Add error handling

### Contributing
1. Report bugs through GitHub issues
2. Suggest features
3. Submit pull requests
4. Share your Flares

## License
MIT License - See LICENSE file

## Author
Created by Alex Kristiansen ([@AlexXYK](https://github.com/AlexXYK))
