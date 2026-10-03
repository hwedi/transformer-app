# Transformer Health Check

The web app at https://transformer.stochos.dev. Every time you save a change here, it goes live by itself.

## What happens when you change something

| You change | How long until it is live | What happens |
|---|---|---|
| Anything inside `static/` (the page: wording, colours, layout) | about 30 to 60 seconds | Only that file is sent. The app does not restart. |
| `app.py`, `requirements.txt`, `artifacts/` or `samples/` (the server or the models) | 5 to 20 minutes, then 1 to 3 minutes while the models load | Azure reinstalls everything. This is slow because TensorFlow and PyTorch are large. |
| Only notes (`README.md`) | nothing is deployed | |

## One-time setup (about 10 minutes)

1. **Add your model files.** Next to `app.py`, this repository needs the two folders `artifacts` and `samples`.
   Copy them from your old `transformer_website` folder. Without them the first deploy stops with a clear message.
2. **Check that GitHub kept the `.github` folder.** You should see `.github/workflows/deploy.yml` and `.github/scripts/deploy.py`.
   If they are missing, click Add file, Create new file, type `.github/workflows/deploy.yml` as the name, and paste in the contents.
   Do the same for `.github/scripts/deploy.py`.
3. **Give GitHub permission to deploy.**
   - In the Azure portal open your app `transformer-health-libya-2026`. On the Overview page click **Download publish profile** (top bar). A file is saved.
   - Open that file with Notepad, press Ctrl+A, then Ctrl+C.
   - In this repository on GitHub: **Settings, Secrets and variables, Actions, New repository secret**.
     Name: `AZURE_WEBAPP_PUBLISH_PROFILE`. Value: paste everything. Save.
   - Keep this repository **private**. The secret is encrypted, but the models are yours.
4. **Run the first deploy.** Open the **Actions** tab, click **Deploy to Azure**, then **Run workflow**, tick the box, and run it.
   It stays yellow for 10 to 20 minutes. A green tick means it worked. Then open the site.

Azure itself needs nothing new. The settings you already made (basic authentication, `python app.py`, the port) stay as they are.
Do not switch off "SCM Basic Auth Publishing Credentials" in the app's Configuration page, or deploys will stop working.

## Everyday use

1. On GitHub open the file, for example `static/css/app.css`.
2. Click the pencil icon, make the change, click **Commit changes**.
3. Open the **Actions** tab. When the run shows a green tick, refresh the site.

You can also drag changed files onto the repository page and commit, or use GitHub Desktop.

## If a run turns red

Open the run and read the red line. The usual causes:
- **"secret is empty" or "does not look like a publish profile":** redo step 3. Paste the whole file.
- **"Azure refused the package (HTTP 401)":** the secret is out of date or basic authentication is off. Download a fresh publish profile and replace the secret.
- **"Azure could not install the package":** the lines printed under it come from Azure. Usually a mistake in `requirements.txt`.
- **"artifacts/ is missing":** do step 1.
- To go back to a working version: open the last green commit on GitHub, copy its files back, and commit.

If a quick page update does not show on the live site, the script notices and does a full deploy by itself.
