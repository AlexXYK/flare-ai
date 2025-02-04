# FLARE.ai for Obsidian

A powerful AI chat interface for Obsidian featuring customizable personas (Flares), multiple provider support, and seamless conversation management.

![FLARE.ai Interface](screenshots/main.png)

## Features

### 🤖 Multiple AI Provider Support
- **Local AI** through Ollama
- **OpenAI** API integration
- **OpenRouter** API support
- Easy provider configuration
- Dynamic model selection
- Real-time model refresh
- Streaming responses

### 🔥 Flare Management
- Create custom AI personas
- Configure provider settings
- Set temperature and token limits
- Custom system prompts
- Easy flare switching with @mentions
- Markdown-based storage

### ⚡ Modern UI/UX
- [[Wikilinked]] notes from your vault directly into chat or system prompts
- **Dataview** query support in chat and system prompts
- Clean, consistent interface
- Multiple view locations
- Real-time settings updates
- Message actions (copy, delete)
- Stop generation support
- Auto-generated chat titles

## Installation

1. Open Obsidian Settings
2. Go to Community Plugins
3. Search for "FLARE.ai"
4. Click Install
5. Enable the plugin

Or manually:
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/AlexXYK/flare-ai/releases/latest)
2. Create a `flare-ai` folder in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into the folder
4. Enable the plugin in Obsidian settings

## Quick Start

1. Open Settings > FLARE.ai
2. Add at least one provider:
   - For Ollama: Use default endpoint `http://localhost:11434` or a remote endpoint
   - For OpenAI: Add your API key
   - For OpenRouter: Add your API key
3. Create your first Flare via the "Create Flare" button in the settings
4. Start chatting!

> If you encounter any issues during initial setup (i.e. models not appearing in the title generation dropdown or the reasoning model toggle not appearing when selecting an Ollama provider in the Flare congig menu), simply navigate out of the settings tab and back in.

## Using Flares

Flares are markdown files that define AI personas. They live in your vault and can be edited directly.

Example Flare:
```markdown
---
name: CodeAssistant
description: Programming and technical help
provider: ollama-default
model: llama3.1
temperature: 0.7
maxTokens: 2048
contextWindow: 3  # Number of conversation pairs to maintain during chat
handoffContext: 1  # Number of pairs to carry over when switching flares
stream: true
enabled: true
isReasoningModel: false
---

You are an expert programmer focused on clear explanations and practical examples.
- Provide code snippets when relevant
- Explain complex concepts simply
- Suggest best practices
```

## Features in Detail

### Chat Features
- Switch models on the fly by starting your message with `@flarename`
- Adjust creativity with temperature
- Change providers instantly
- Settings persist per chat
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

## Screenshots

### Main Interface
![Main Interface](screenshots/main.png)

### Settings
![Settings](screenshots/settings.png)

### Flare Management
![Flare Management](screenshots/flares.png)

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
1. Clone the repository
2. Install dependencies with `npm install`
3. Build the plugin with `npm run build`
4. Link to your test vault

For more details, see the [Contributing Guide](CONTRIBUTING.md).

## Support

- 📝 [Report a Bug](https://github.com/AlexXYK/flare-ai/issues/new?template=bug_report.md)
- 💡 [Request a Feature](https://github.com/AlexXYK/flare-ai/issues/new?template=feature_request.md)
- 🤝 [Contribute](CONTRIBUTING.md)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

Created by Alex Kristiansen ([@AlexXYK](https://github.com/AlexXYK))
Note: I am not a developer. This plugin was built partially to fulfill a personal need and partially as an exercise in AI coding and development.

---

<div align="center">
If you find FLARE.ai helpful, please consider starring the repository! ⭐
</div>
