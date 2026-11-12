# Small version (3 MB, 24 files) - easy to upload to GitHub

If GitHub says "too many files / failed", upload in 3 rounds (each round: drag, then click "Commit changes"):
  Round 1: package.json  and  vercel.json   (the two loose files)
  Round 2: the folder  api
  Round 3: the folder  public   (then in the repo click Add file -> Upload files if you need to add more)
Then: vercel.com/new -> Import -> Deploy -> Storage -> Create Database -> Neon -> Connect Project
Settings -> Environment Variables: ADMIN_EMAIL, SENDER_EMAIL, BREVO_API_KEY, GEMINI_API_KEY (needed for the object scanner)
-> Deployments -> ... -> Redeploy.
The object scanner in this small version uses Google Gemini (free key at aistudio.google.com); without the key it shows a clear message.
