# Demo Markup

Mark up your screen recordings, then let an AI agent (Claude Code, Codex, etc.) edit them into a demo video.

Line up clips on a timeline, select parts, and add notes: label, cut, speed up, narrate, or any instruction. The notes are saved as `demo-markup.json` next to your videos. Everything runs locally.

## Run

```bash
npm install
npm start -- ~/path/to/recordings
```

Open http://localhost:5173. Press `?` for shortcuts. When you are done, click **Copy prompt for AI** and paste it into your agent.

## License

MIT
