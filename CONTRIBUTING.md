# Contributing to FLARE.ai

Thank you for your interest in contributing to FLARE.ai! This document provides guidelines and instructions for contributing.

## Development Setup

1. Clone the repository
2. Install dependencies with `npm install`
3. Build the plugin with `npm run build`
4. Link the plugin to your test vault:
   ```bash
   ln -s /path/to/repo /path/to/vault/.obsidian/plugins/flare-ai
   ```

## Development Process

1. Create a new branch for your feature/fix
2. Make your changes
3. Test thoroughly
4. Update documentation if needed
5. Submit a pull request

## Building

- Development build: `npm run dev`
- Production build: `npm run build`

## Code Style

- Follow TypeScript best practices
- Use meaningful variable names
- Comment complex logic
- Follow existing patterns in the codebase

## Testing

Before submitting a PR:
1. Test with multiple providers
2. Test on both desktop and mobile
3. Test error cases
4. Verify no console errors

## Pull Request Process

1. Update the README.md with details of changes if needed
2. Update the version numbers if needed
3. The PR will be merged once you have the sign-off

## Questions?

Feel free to open an issue for any questions! 