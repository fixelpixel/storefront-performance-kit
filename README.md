# Storefront performance kit

CLI tools for inspecting storefront scripts, collecting Lighthouse evidence and comparing before/after measurements. The toolkit also checks candidate theme renders for missing CSS, Liquid errors and changed app embeds.

## Run locally

Use Node.js 22 and Chrome or Chromium.

```sh
npm ci
npm test
npm run kit -- audit https://example.com --no-psi
node cdp-eval.mjs https://example.com 'document.title'
```

`CHROME_PATH` selects the browser for Chrome Launcher. `npm run kit` lists commands. Public storefront checks need no Shopify account. PageSpeed may require `PAGESPEED_API_KEY` when anonymous quota is exhausted. Theme, backup and verification commands require your own Shopify Admin API access. AI diagnosis additionally needs `OPENROUTER_API_KEY` and makes external requests.

## Stack and limits

Node.js, Lighthouse, Chrome Launcher and an optional Express OAuth helper. Measurements depend on the selected device, URL, browser and network. Keep the method fixed when comparing runs. A lab score does not prove checkout or tracking correctness.

All test records are synthetic. Fleet inventories, client benchmarks, sales notes and the private knowledge base are excluded. `src/kb.mjs` provides generic storage code; no findings or cases are bundled. Set `SPEEDKIT_HOME` and `SPEEDKIT_PROJECTS` to choose local storage folders. Theme commands can write to your store; use a development store for evaluation.

Licensed under Apache-2.0. See [LICENSE](LICENSE).
