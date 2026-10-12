# Maintaining and upgrading PRESENTER

Everything below works from a browser on github.com plus, optionally, a computer with Node 20. You never have to edit generated files.

## 1. First-time setup on GitHub
1. Create / open `https://github.com/mranandkumar4777/p1-app-pc` and upload **everything** in this folder (keep the `.github` folder and the hidden files).
2. **Settings → Actions → General → Workflow permissions → Read and write → Save.** (The workflows publish the Releases.)
3. **Actions → Build desktop app → Run workflow**, and **Build Android remote app (APK) → Run workflow**.
4. Download from **Releases**: `desktop-latest` (Windows `.exe`, Mac `.dmg`) and `mobile-latest` (`PresenterRemote.apk`).

Every push also runs **Checks** (a quick syntax / packaging / AI-hub test run). A red ✗ there means "fix before releasing".

## 2. Release a new version (the normal routine)
1. Change code, commit, push. Wait for **Checks** to go green.
2. Tag it: `git tag v1.2.0 && git push origin v1.2.0` (or Actions → Run workflow).
   The tag *is* the version: no need to edit `package.json`. Both workflows start automatically.
3. Windows users get the update automatically (asks "Restart now / Later"). Mac users see a download popup. Phones get web changes silently and a new APK through an "Update Available" popup.

## 3. Run the checks yourself (optional, 5 seconds)
```
npm run check     # every JS file + every inline <script> parses, every require() resolves,
                  # every runtime file is listed in package.json "build.files", Android plugin list is complete
npm test          # AI hub tests (fake servers: Gemini, OpenRouter, custom, music catalogs; no network, no keys)
```

## 4. Where things live (what to edit for what)
| I want to change… | Edit |
|---|---|
| AI providers, retries, fallbacks, song detection, error texts | `ai-hub.js` (then `npm test`) |
| AI settings storage / IPC | `main.js` (search `setAiConfig`), `preload.js` |
| Settings screen, song-detection UI | `public/presenter.html` (search `aiExtraSettings`, `aiIdentBtn`) |
| Phone remote screens | `public/remote.html` **and** copy it to `mobile/www/remote.html` (they must be identical) |
| Phone launcher / updater | `mobile/www/main.js`, `mobile/www/updater.js`, `mobile/www/index.html` |
| Captions / Whisper / Bible references | `speech/*.js` |
| Server, PIN, phone pairing | `server.js` |
| Windows/Mac installer settings | `package.json` → `build` |
| Android app id, permissions, native code | `mobile/android/app/…` (`AndroidManifest.xml`, `build.gradle`, `src/main/java/…`) |

### Adding a new `.js` file or folder
If the desktop app `require()`s it, it **must** be covered by `package.json → build.files` (e.g. `"speech/**/*"`). `npm run check` fails if you forget, which is exactly the "module not found after installing" crash.

## 5. AI providers and models (no code needed)
Open PRESENTER → **Settings**:
- **Gemini API key(s)** and **OpenRouter API key(s)**: several keys separated by commas; a rate-limited key rests and the next is used.
- **Other providers**: one per line.
  `openai = sk-…` (presets: openai, groq, together, mistral, deepseek, xai, ollama, lmstudio) or
  `myhost | https://host.example/v1 | key1, key2 | X-Org: acme` for any OpenAI-compatible endpoint (custom headers after the 3rd `|`).
- **Models, in fallback order**: `provider:model` per line, e.g. `gemini:gemini-2.5-flash`, `openrouter:google/gemini-2.5-flash`, `openai:gpt-4o-audio-preview`. A bare `google/…` id means OpenRouter, `gemini-…` means Gemini, `gpt-…` means OpenAI.
- **Detect models** lists what each provider offers (🎤 = accepts audio, needed for song listening) and adds your pick to the list. **Test connection** checks the first line.
- If a model is busy/down: it is retried (503/timeouts) then the next model, then the other providers' defaults, automatically. Tuning knobs are at the top of `ai-hub.js` (`DEFAULTS`, `DEFAULT_MODELS`, `COOL`).
- When a model name is retired by its provider, only the Settings list needs changing: no code, no new release.
- Detected songs are checked against the public iTunes and Deezer catalogs (title + artist text only). Unknown titles are marked unverified and capped at 60 % confidence so they never auto-load. Turn off with `PRESENTER_AI_VERIFY=0` or `"verify": false` in the AI config.
- Environment variables also work: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `<PROVIDER>_API_KEY`, `PRESENTER_AI_MODELS`, `PRESENTER_AI_DEBUG=1` (prints provider / model / error code, never keys).

## 6. Android specifics (important)
- **Never delete or replace** `mobile/android/app/presenter-update.keystore`: Android only updates an installed app if the signing key is identical.
- `versionCode` is the workflow run number (always rising). If a release changes **native** code or **plugins**, write that release's versionCode into `mobile/min-native-version-code.txt` so older APKs are forced to update.
- Add an Android plugin: `cd mobile && npm install <plugin> && npx cap sync android`, commit the changes (including `android/capacitor.settings.gradle` and `android/app/capacitor.build.gradle`).
- Upgrade Capacitor: `cd mobile && npm install @capacitor/core@latest @capacitor/android@latest @capacitor/cli@latest && npx cap sync android`; keep all three on the same major version. A new major usually also needs a newer Gradle / Android Gradle Plugin in `mobile/android/build.gradle` and `gradle/wrapper/gradle-wrapper.properties`, and Java 17+ in `android.yml`.
- Web-only changes (`mobile/www/*`) reach installed phones silently. Native changes need a new APK install via the popup.

## 7. Upgrading dependencies (desktop)
```
npm install electron@latest electron-builder@latest electron-updater@latest --save-dev   # electron-updater goes in dependencies
npm run check && npm test
```
Then tag a release. Electron upgrades: skim the release notes for breaking changes (`session`, `desktopCapturer`, `safeStorage` are used in `main.js`). Node ≥ 20 is used by the workflows.

## 8. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Actions: "Resource not accessible by integration" | Step 2 of section 1 (Read and write permissions). |
| Android job: `missing …keystore` | The keystore file was not uploaded. It lives in `mobile/android/app/`. |
| Installed APK will not update | Different signing key, or versionCode not higher. Use the key in the repo. |
| Desktop app says "Cannot find module './speech/…'" | A file is missing from `package.json → build.files`; run `npm run check`. |
| Song detection says "No sound was picked up" | Wrong microphone selected, or input level is zero. |
| "The AI service is busy" | The provider was overloaded after 3 retries on every model: add a second model / provider in Settings. |
| "…rejected the API key" | Re-paste the key (Settings); keys are stored encrypted on that computer only. |
| "None of the selected models can listen to audio" | Use **Detect models** and pick one marked 🎤. |
