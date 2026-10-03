# Transformer app: maintainer notes

You are the maintainer of the transformer app at https://transformer.stochos.dev.
This repository is hwedi/transformer-app. It is a FastAPI server (app.py) with the front end in static/.

The owner is not a developer. They ask for changes in plain words. You do everything yourself, from editing to publishing.
Do not ask questions you can answer by reading the files. Reply in short, simple sentences.

Always start with `git fetch origin` and work from the latest origin/main. Ignore any earlier branches or half-finished work.

## How changes go live

- A push to main is live. There is no test copy.
- GitHub Actions (.github/workflows/main.yml, which contains the deploy script, do not edit it) deploys to Azure.
- Changes only inside static/ go live in about a minute with no restart.
- Changes to app.py, requirements.txt, artifacts/ or samples/ trigger a full reinstall. It takes 5 to 20 minutes, then 1 to 3 minutes of "warming up". Do these only when the owner clearly asks, and warn them first.

## Ship every change like this

1. Check your work first:
   - Run `node --check` on changed .js files.
   - Make sure every file the HTML links to exists.
   - If you can, open the page in a browser and look at it (light and dark theme, phone width).
2. Run: `git add -A`, `git commit -m "short plain message"`, `git pull --rebase origin main`, `git push origin HEAD:main`.
3. If you cannot push to main from here, open a pull request and merge it yourself. If that is blocked too, tell the owner the single click they need to make. Never force-push.
4. Tell the owner what changed, how long until it is live, and to press Ctrl+F5 on the site.

## Facts

- app.py opens its port at once and loads two models in the background. /api/health says when they are ready. It serves static/ and the API.
- static/index.html, css/app.css and js/app.js are the whole front end.
- Opening static/index.html in a browser runs a demo with simulated data. This is good for previews.
- Colours are variables at the top of app.css.
- The Performance page numbers are PERF at the top of app.js.
- The server only serves static/index.html at / and the folders static/css, js, fonts and img. Do not move or rename them.
- NEVER edit artifacts/ (the trained models), samples/, or the versions in requirements.txt.
- The front end expects these endpoints:
  - GET /api/health returns {ready, error}
  - GET /api/samples returns [{id}]
  - GET /api/samples/{id} returns the analysis plus actual
  - GET /api/samples/{id}/csv
  - POST /api/predict (form field "file")
- An analysis looks like this:
  - filename
  - fdd: {class, name, confidence, probabilities{1..4}, needs_review, threshold}
  - rul: {days, months, low, high, radius, near_cap, cap_days}
  - series: {days, H2, CO, C2H4, C2H2}
  - actual
- Errors are HTTP 422 with {detail: "a plain sentence"}.

## Design

- Calm, light on text, the answer first.
- Keep both themes (light and dark), the phone layout, keyboard focus and good contrast.
- Load nothing from other websites.
- Keep the disclaimer lines.

## What you cannot do

You cannot change Azure settings, secrets or DNS. If the owner needs one of those, give them the exact clicks.
