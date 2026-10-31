# Desktop app

The desktop app runs Weltbon locally with an embedded database. Your universes and uploads stay on this computer unless you sync them to another Weltbon instance.

## Download

Prebuilt packages are on [GitHub Releases](https://github.com/Yalton/Weltbon/releases/latest):

- **Linux:** the `.AppImage` runs on most distributions (`chmod +x` it, then run it); the `.deb` installs on Debian and Ubuntu.
- **Windows:** run the `Weltbon.Setup.<version>.exe` installer.

macOS packages are not built yet. On a Mac, build from source as below.

## Build from source

You need Node.js 22 and pnpm 9. From the repository root:

```bash
pnpm install
pnpm --filter weltbon-desktop build:app
pnpm --filter weltbon-desktop rebuild
pnpm --filter weltbon-desktop start
```

Launch through `pnpm start` in the `desktop` package (or `electron .` there), so Electron can find the app's package and bundled API. Rebuild the native `bcrypt` and `sharp` modules after changing Electron versions or reinstalling dependencies.

The app creates its database, uploads directory, and local secrets on first launch. On Linux they are under `~/.config/weltbon-desktop/`; on other systems, use Electron's standard app data location. Fully quit Weltbon before copying that directory for a backup.

PDF export is unavailable in the desktop app. Use its other export formats, or export PDF from a Docker-hosted instance.

## Local Ollama audits

Ollama is optional and available in local desktop mode. Start an Ollama server on this computer or your network, then open **LLM connections → Local Ollama** in Weltbon. Enter the server URL (for example, `http://localhost:11434`) and save the connection. In a universe's settings, choose Ollama as the audit provider and select a model marked as supporting tools. Run an audit from that universe.

The first run may take longer while Ollama loads the model. If the model is unavailable in the picker, check that it is installed and supports tool calls.
