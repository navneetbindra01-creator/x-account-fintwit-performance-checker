# Analyzer quick reference

See the main [README.md](README.md) for full setup.

```powershell
# 1 month, regex only
node analyze-account.js --account RockBtmEntries

# 3 months, LLM sides, monthly PDFs
node analyze-account.js --account RockBtmEntries --period 3m --llm --max-scrolls 150
```

Requires Chrome session (`npm run start-chrome` + login once). Optional LLM needs `XAI_API_KEY` in `.env` (copy from `.env.example`).
